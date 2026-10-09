import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import * as contract from "@platform/contracts";
import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { oauthClient } from "../../src/lib/server/auth-schema.ts";
import { apiResource } from "../../src/lib/server/auth-options.ts";
import { createTestEnvironment } from "../environment.ts";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_IMAGE_TESTS"] === "1")("release container images", () => {
  it("initializes storage, renders edge configuration and deploys a Worker through the packaged agent", async () => {
    const environment = await createTestEnvironment("http://localhost:25434");
    const state = await mkdtemp(join(tmpdir(), "widefleet-image-test-"));
    const suffix = crypto.randomUUID();
    const name = `platform-image-test-${suffix}`;
    const artifactBucket = `image-artifacts-${suffix}`;
    const fleetBucket = `image-fleets-${suffix}`;
    const databaseUrl = new URL(environment.environment.DATABASE_URL);
    databaseUrl.hostname = "postgres";
    databaseUrl.port = "5432";

    const settings = {
      ...environment.environment,
      DATABASE_URL: databaseUrl.href,
      S3_ENDPOINT: "http://rustfs:9000",
      S3_BUCKET: artifactBucket,
      FLEET_S3_BUCKET: fleetBucket,
      PORT: "25434",
    };

    const arguments_ = [
      "--network",
      "internal-app-platform-test_default",
      ...Object.entries(settings).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ];

    const image = process.env["PLATFORM_CONTROL_PLANE_IMAGE"] ?? "app-platform-control-plane:0.1.0";
    const agentImage = process.env["PLATFORM_AGENT_IMAGE"] ?? "app-platform-agent:0.1.0";
    const runtimeImage = process.env["PLATFORM_RUNTIME_IMAGE"] ?? "app-platform-runtime:0.1.0";
    let fleetId: string | undefined;

    const s3 = new S3Client({
      endpoint: environment.environment.S3_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: environment.environment.S3_ACCESS_KEY_ID,
        secretAccessKey: environment.environment.S3_SECRET_ACCESS_KEY,
      },
    });

    let running = false;
    let storageInitialized = false;

    try {
      await execute("docker", [
        "run",
        "--rm",
        "--network=none",
        "--user=0:0",
        "--volume",
        `${state}:/installation`,
        "--env=PLATFORM_DATA_DIRECTORY=/installation",
        "--env=PLATFORM_CONFIG_DIRECTORY=/installation/config",
        "--env=PLATFORM_URL=https://platform.example.test",
        "--env=APP_DOMAIN=apps.example.test",
        image,
        "node",
        "tools/configure-edge.ts",
      ]);

      // Read as root inside the container too: config directories are intentionally private.
      const rendered = await execute("docker", [
        "run",
        "--rm",
        "--network=none",
        "--user=0:0",
        "--volume",
        `${state}:/installation:ro`,
        image,
        "node",
        "--input-type=module",
        "--eval",
        'import { readFile } from "node:fs/promises"; console.log(JSON.stringify({ middleware: JSON.parse(await readFile("/installation/config/routes/app-auth.yaml", "utf8")), proxy: JSON.parse(await readFile("/installation/config/traefik.json", "utf8")) }));',
      ]);

      const configuration = z.unknown().parse(JSON.parse(rendered.stdout));
      expect(configuration).toHaveProperty("middleware.http.middlewares");
      expect(configuration).toHaveProperty("proxy.providers.file.directory", "/config/routes");
      expect(configuration).not.toHaveProperty("proxy.certificatesResolvers");

      // Only this fixture's randomly named database is reset.
      await environment.database.db.execute(
        sql`DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public`,
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        await execute("docker", [
          "run",
          "--rm",
          ...arguments_,
          image,
          "node",
          "tools/initialize.ts",
        ]);
        await execute("docker", [
          "run",
          "--rm",
          ...arguments_,
          image,
          "node",
          "tools/initialize-storage.ts",
        ]);
        storageInitialized = true;
      }

      expect(await environment.database.db.select().from(oauthClient)).toHaveLength(1);

      for (const bucket of [artifactBucket, fleetBucket]) {
        expect(
          (await s3.send(new HeadBucketCommand({ Bucket: bucket }))).$metadata.httpStatusCode,
        ).toBe(200);
      }

      await execute("docker", [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--publish=127.0.0.1:25434:25434",
        ...arguments_,
        image,
      ]);
      running = true;
      await expect
        .poll(
          async () => {
            const result = await execute("docker", [
              "exec",
              name,
              "node",
              "--input-type=module",
              "--eval",
              'const r = await fetch("http://127.0.0.1:25434/healthz"); console.log(await r.text());',
            ]);

            return z.object({ status: z.string() }).parse(JSON.parse(result.stdout)).status;
          },
          { timeout: 15_000 },
        )
        .toBe("ok");

      const response = await execute("docker", [
        "exec",
        name,
        "node",
        "--input-type=module",
        "--eval",
        'console.log((await fetch("http://127.0.0.1:25434/api/v1/me")).status);',
      ]);

      expect(response.stdout.trim()).toBe("401");

      const person = environment.users.createUser({
        name: "Image fixture",
        email: "image@example.test",
      });

      await environment.users.saveUser(person);
      await environment.linkMicrosoftUser(person.id, z.uuid().parse(environment.ownerSubject));
      const now = Math.floor(Date.now() / 1000);

      const { token } = await environment.auth.api.signJWT({
        body: {
          payload: {
            sub: person.id,
            aud: apiResource(environment.configuration),
            iss: `${environment.configuration.PLATFORM_URL}/api/auth`,
            iat: now,
            exp: now + 300,
            scope: "platform:read platform:write",
          },
        },
      });

      const request = async (path: string, method: string, body?: BodyInit) => {
        const headers = new Headers({
          authorization: `Bearer ${token}`,
          origin: environment.configuration.PLATFORM_URL,
          // This loopback-only fixture acts as the trusted reverse proxy.
          "x-forwarded-proto": "http",
        });

        if (!(body instanceof FormData)) headers.set("content-type", "application/json");
        headers.set("idempotency-key", crypto.randomUUID());
        const options: RequestInit = { method, headers };

        if (body !== undefined) options.body = body;

        const result = await fetch(
          `${environment.configuration.PLATFORM_URL}/api/v1${path}`,
          options,
        );

        if (!result.ok) throw new Error(`${result.status}: ${await result.text()}`);

        return z.unknown().parse(await result.json());
      };

      const registration = z
        .object({ agent: contract.agent, token: z.string() })
        .parse(await request("/agents", "POST", JSON.stringify({ name: "Image fixture" })));

      const app = contract.app.parse(
        await request(
          "/apps/by-name/image-fixture",
          "PUT",
          JSON.stringify({ slug: "image-fixture" }),
        ),
      );

      fleetId = app.fleetId;

      const session = contract.uploadSession.parse(
        await request(
          `/apps/${app.id}/assets-upload-session`,
          "POST",
          JSON.stringify({ manifest: {} }),
        ),
      );

      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2026-10-01",
          compatibility_flags: [],
          bindings: [],
          assets: { upload_session: session.id, binding: "ASSETS" },
        }),
      );
      form.set(
        "worker.js",
        new Blob(['export default { fetch() { return new Response("release image works"); } };'], {
          type: "application/javascript+module",
        }),
        "worker.js",
      );

      const deployment = contract.deployment.parse(
        await request(`/apps/${app.id}/worker`, "PUT", form),
      );

      const socket = (
        await execute("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
      ).stdout.trim();

      expect(socket.startsWith("unix://")).toBe(true);

      const agentSettings = {
        PLATFORM_URL: environment.configuration.PLATFORM_URL,
        PLATFORM_AGENT_TOKEN: registration.token,
        DOCKER_HOST: "unix:///var/run/docker.sock",
        PLATFORM_AGENT_STATE: "/state",
        PLATFORM_AGENT_HOST_STATE: state,
        PLATFORM_ROUTING_DIRECTORY: "/state/routes",
        PLATFORM_RUNTIME_IMAGE: runtimeImage,
        CELLD_BINARY: "/usr/local/bin/celld",
        FLEET_S3_ENDPOINT: "http://rustfs:9000",
        FLEET_RUNTIME_S3_ENDPOINT: "http://internal-app-platform-test-rustfs-1:9000",
        FLEET_S3_BUCKET: fleetBucket,
        FLEET_S3_ACCESS_KEY_ID: environment.environment.S3_ACCESS_KEY_ID,
        FLEET_S3_SECRET_ACCESS_KEY: environment.environment.S3_SECRET_ACCESS_KEY,
        PLATFORM_TRUSTED_CONTAINERS: "internal-app-platform-test-rustfs-1",
      };

      const agent = () =>
        execute(
          "docker",
          [
            "run",
            "--rm",
            "--network",
            `container:${name}`,
            "--volume",
            `${socket.slice("unix://".length)}:/var/run/docker.sock`,
            "--volume",
            `${state}:/state`,
            ...Object.entries(agentSettings).flatMap(([key, value]) => [
              "--env",
              `${key}=${value}`,
            ]),
            agentImage,
            "--once",
          ],
          { timeout: 90_000 },
        );

      await agent();

      const history = z
        .array(contract.deployment)
        .parse(await request(`/apps/${app.id}/deployments`, "GET"));

      expect(history).toEqual([
        expect.objectContaining({ id: deployment.id, status: "succeeded" }),
      ]);

      const worker = await execute("docker", [
        "exec",
        `platform-fleet-${app.fleetId}`,
        "curl",
        "--fail",
        "--silent",
        "--max-time",
        "15",
        "-H",
        `Host: ${app.hostname}`,
        "http://127.0.0.1:8080/",
      ]);

      expect(worker.stdout).toBe("release image works");

      const usedImage = await execute("docker", [
        "inspect",
        `platform-fleet-${app.fleetId}`,
        "--format",
        "{{.Config.Image}}",
      ]);

      const selectedImage = await execute("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        runtimeImage,
      ]);

      expect(usedImage.stdout.trim()).toBe(selectedImage.stdout.trim());
      await request(`/apps/${app.id}`, "DELETE");
      await agent();
    } finally {
      if (fleetId) {
        const appName = `platform-fleet-${fleetId}`;
        await execute("docker", ["rm", "--force", appName]).catch(() => undefined);
        await execute("docker", [
          "network",
          "disconnect",
          appName,
          "internal-app-platform-test-rustfs-1",
        ]).catch(() => undefined);
        await execute("docker", ["network", "rm", appName]).catch(() => undefined);
      }

      if (running) await execute("docker", ["rm", "--force", name]);

      if (storageInitialized) {
        for (const bucket of [artifactBucket, fleetBucket]) {
          while (true) {
            const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));

            const objects = (page.Contents ?? []).flatMap((item) =>
              item.Key ? [{ Key: item.Key }] : [],
            );

            if (objects.length === 0) break;
            await s3.send(
              new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
            );
          }

          await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
      }

      s3.destroy();
      await environment.close();
      // Rootful Docker can create root-owned fixture files; remove only this private test mount.
      await execute("docker", [
        "run",
        "--rm",
        "--network=none",
        "--user=0:0",
        "--volume",
        `${state}:/state`,
        image,
        "node",
        "--input-type=module",
        "--eval",
        'import { readdir, rm } from "node:fs/promises"; for (const entry of await readdir("/state")) await rm(`/state/${entry}`, { recursive: true, force: true });',
      ]);
      await rm(state, { recursive: true, force: true });
    }
  }, 180_000);
});
