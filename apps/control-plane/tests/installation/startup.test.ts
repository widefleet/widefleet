import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestEnvironment } from "../environment.ts";
import { createCertificates } from "./certificates.ts";
import { installationSettings } from "./settings.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")("First container startup", () => {
  it("creates the schema, writable shared volumes and first-admin UI without preparatory commands", async () => {
    const environment = await createTestEnvironment();
    const directory = await mkdtemp(join(tmpdir(), "widefleet-startup-"));
    const name = `widefleet-startup-${randomUUID()}`;
    const certificates = await createCertificates(directory);
    await mkdir(join(directory, "tls"));
    await copyFile(certificates.certificate, join(directory, "tls/fullchain.pem"));
    await copyFile(certificates.key, join(directory, "tls/privkey.pem"));
    const databaseUrl = new URL(environment.environment.DATABASE_URL);
    databaseUrl.hostname = "postgres";
    databaseUrl.port = "5432";
    await environment.database.db.execute(
      sql`DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public`,
    );

    const settings = {
      ...installationSettings,
      DATABASE_URL: databaseUrl.href,
      PLATFORM_CONTROL_PLANE_IMAGE:
        process.env["PLATFORM_CONTROL_PLANE_IMAGE"] ?? "widefleet-control-plane:sso-check",
      PLATFORM_SSO_IMAGE: process.env["PLATFORM_SSO_IMAGE"] ?? "widefleet-sso:setup-check",
      PLATFORM_DATA_DIRECTORY: directory,
    };

    const environmentFile = join(directory, "installation.env");
    const overrideFile = join(directory, "compose.yaml");
    await writeFile(
      environmentFile,
      Object.entries(settings)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    await writeFile(
      overrideFile,
      `services:\n  proxy:\n    container_name: ${name}-proxy\n    ports: !reset []\nnetworks:\n  management:\n    external: true\n    name: internal-app-platform-test_default\n`,
    );

    const compose = (...args: string[]) =>
      execute(
        "docker",
        [
          "compose",
          "--project-name",
          name,
          "--env-file",
          environmentFile,
          "-f",
          "infra/compose.base.yaml",
          "-f",
          "infra/compose.azure.yaml",
          "-f",
          overrideFile,
          ...args,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env["PATH"],
            HOME: process.env["HOME"],
            DOCKER_HOST: process.env["DOCKER_HOST"],
            DOCKER_CONFIG: process.env["DOCKER_CONFIG"],
          },
        },
      );

    const inspect = async () => {
      const result = await compose(
        "exec",
        "-T",
        "control-plane",
        "node",
        "--input-type=module",
        "--eval",
        `
        import {readFile,stat} from "node:fs/promises";
        import {createHash} from "node:crypto";
        const key = "/var/lib/widefleet/encryption.key";
        const owner = await stat(key);
        const setup = await fetch("http://127.0.0.1:3000/setup");
        const body = await setup.text();
        const auth = await stat("/var/lib/widefleet/auth");
        console.log(JSON.stringify({setup: setup.status, form: body.includes("Your first administrator account"), key: createHash("sha256").update(await readFile(key)).digest("hex"), mode: owner.mode & 511, authOwner: auth.uid}));
      `,
      );

      return z
        .object({
          setup: z.number(),
          form: z.boolean(),
          key: z.string(),
          mode: z.number(),
          authOwner: z.number(),
        })
        .parse(JSON.parse(result.stdout));
    };

    try {
      await compose("up", "-d", "--wait", "control-plane", "oauth2-proxy", "proxy");
      const first = await inspect();
      expect(first).toMatchObject({ setup: 200, form: true, mode: 0o600, authOwner: 1000 });
      const ca = await readFile(certificates.ca, "utf8");
      await vi.waitFor(
        async () => {
          const response = await compose(
            "exec",
            "-T",
            "control-plane",
            "node",
            "--input-type=module",
            "--eval",
            `
          import {get} from "node:https";
          await new Promise((resolve,reject) => {
            const request=get({hostname:"proxy",port:8443,path:"/setup",servername:"platform.example.test",ca:process.argv[1],headers:{host:"platform.example.test"}}, response => {
              let body=""; response.on("data", chunk=>body+=chunk); response.on("end",()=>{console.log(JSON.stringify({status:response.statusCode,form:body.includes("Your first administrator account")}));resolve();});
            }); request.on("error",reject);
          });
        `,
            "--",
            ca,
          );

          expect(JSON.parse(response.stdout)).toEqual({ status: 200, form: true });
        },
        { timeout: 15_000 },
      );

      const result = await compose(
        "exec",
        "-T",
        "control-plane",
        "node",
        "--input-type=module",
        "--eval",
        `
        const response = await fetch("http://127.0.0.1:3000/api/v1/setup", {method:"POST", headers:{"content-type":"application/json",origin:"https://platform.example.test"},body:JSON.stringify({name:"IT Admin",email:"setup@example.test",password:"first-container-password"})});
        console.log(response.status);
      `,
      );

      expect(result.stdout.trim()).toBe("200");
      await compose("up", "-d", "--wait", "--force-recreate", "control-plane");
      const restarted = await inspect();
      expect(restarted.key).toBe(first.key);
      expect(restarted.form).toBe(false);
    } catch (cause) {
      const logs = await compose("logs", "control-plane", "proxy");
      console.error(logs.stdout, logs.stderr);
      throw cause;
    } finally {
      await compose("down", "--volumes", "--remove-orphans");
      await environment.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
