import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configurationSchema } from "../../src/lib/server/config.ts";
import { installationSettings } from "./settings.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const serviceSchema = z.object({
  ports: z.array(z.unknown()).default([]),
  networks: z.record(z.string(), z.unknown()).default({}),
  environment: z
    .record(z.string(), z.string().nullable())
    .default({})
    // Compose omits null-valued variables from the container environment.
    .transform((value) =>
      Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null)),
    ),
  depends_on: z.record(z.string(), z.unknown()).default({}),
  volumes: z
    .array(z.object({ source: z.string(), target: z.string(), read_only: z.boolean().optional() }))
    .default([]),
});

const render = async (files: string[], settings: Record<string, string> = installationSettings) => {
  const directory = await mkdtemp(join(tmpdir(), "widefleet-compose-"));

  try {
    const environmentFile = join(directory, "deployment.env");
    await writeFile(
      environmentFile,
      Object.entries(settings)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );

    const result = await execute(
      "docker",
      [
        "compose",
        "--env-file",
        environmentFile,
        ...files.flatMap((file) => ["-f", `infra/${file}.yaml`]),
        "--profile",
        "agent",
        "--profile",
        "tools",
        "--profile",
        "images",
        "config",
        "--format",
        "json",
      ],
      { cwd: root, env: { PATH: process.env["PATH"], HOME: process.env["HOME"] } },
    );

    return z
      .object({ services: z.record(z.string(), serviceSchema) })
      .parse(JSON.parse(result.stdout));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const matrix = ["local", "external"].flatMap((database) =>
  ["rustfs", "s3", "azure", "gcs"].flatMap((storage) =>
    ["provided", "cloudflare"].map((tls) => ({ database, storage, tls })),
  ),
);

describe.runIf(process.env["RUN_INSTALLATION_TESTS"] === "1")(
  "supported Compose installations",
  () => {
    it("starts without identity settings and separates shared proxy state from the database", async () => {
      const { services } = await render(["compose.base", "compose.azure"]);
      const control = serviceSchema.parse(services["control-plane"]);
      const sso = serviceSchema.parse(services["oauth2-proxy"]);
      expect(configurationSchema.parse(control.environment).IDENTITY).toBeNull();
      expect(control.environment).not.toHaveProperty("ENTRA_CLIENT_SECRET");
      expect(sso.environment).not.toHaveProperty("DATABASE_URL");
      expect(sso.depends_on).toEqual({});
      expect(
        control.volumes.find((mount) => mount.target === "/var/lib/widefleet/auth")?.source,
      ).toBe(sso.volumes.find((mount) => mount.target === "/auth")?.source);
      expect(control.volumes.some((mount) => mount.target.includes("docker.sock"))).toBe(false);
      expect(services).not.toHaveProperty("configure-edge");
    });

    it.each(matrix)(
      "renders $database PostgreSQL, $storage storage and $tls TLS",
      async ({ database, storage, tls }) => {
        const files = ["compose.base"];

        if (database === "local") files.push("compose.postgres");
        files.push(storage === "rustfs" ? "compose.s3" : `compose.${storage}`);

        if (storage === "rustfs") files.push("compose.rustfs");

        if (tls === "cloudflare") files.push("compose.acme-cloudflare");

        const { services } = await render(
          files,
          storage === "s3"
            ? { ...installationSettings, S3_ENDPOINT: "https://storage.example.test" }
            : installationSettings,
        );

        const control = serviceSchema.parse(services["control-plane"]);
        const agent = serviceSchema.parse(services["agent"]);

        const configuration = configurationSchema.parse(control.environment);

        expect(configuration.PLATFORM_USAGE_REPORTING).toBe(false);
        expect(configuration.PLATFORM_CRASH_REPORTING).toBe(false);
        expect(agent.environment["PLATFORM_USAGE_REPORTING"]).toBe("false");
        expect(agent.environment["PLATFORM_CRASH_REPORTING"]).toBe("false");

        if (storage === "s3")
          expect(agent.environment["FLEET_RUNTIME_S3_ENDPOINT"]).toBe(
            "https://storage.example.test",
          );
        expect(configuration.ARTIFACT_STORAGE_PROVIDER).toBe(storage === "rustfs" ? "s3" : storage);
        expect(Boolean(services["postgres"])).toBe(database === "local");
        expect(Boolean(control.depends_on["postgres"])).toBe(database === "local");
        expect(Boolean(services["storage"])).toBe(storage === "rustfs");
        expect(Boolean(control.depends_on["storage"])).toBe(storage === "rustfs");
        expect(agent.environment["PLATFORM_TRUSTED_CONTAINERS"]).toBe(
          storage === "rustfs" ? "app-platform-proxy,app-platform-storage" : "app-platform-proxy",
        );
        expect(configuration.TLS_MODE).toBe(tls);
        expect(agent.environment["TLS_MODE"] ?? "provided").toBe(tls);
        expect(agent.environment["APP_DOMAIN"]).toBe(configuration.APP_DOMAIN);
        expect(services["proxy"]?.volumes.some((mount) => mount.target === "/acme")).toBe(
          tls === "cloudflare",
        );
        expect(control.environment["CF_DNS_API_TOKEN_FILE"]).toBeUndefined();
        expect(agent.environment["CF_DNS_API_TOKEN_FILE"]).toBeUndefined();

        if (storage === "azure" || storage === "gcs")
          expect(
            Object.keys(agent.environment).filter((key) => key.startsWith("FLEET_S3_")),
          ).toEqual([]);
      },
    );

    it("selects the installation through COMPOSE_FILE in the private environment", async () => {
      const selection = ["compose.base", "compose.azure", "compose.acme-cloudflare"];
      expect(
        await render([], {
          ...installationSettings,
          COMPOSE_FILE: selection.map((file) => `infra/${file}.yaml`).join(":"),
        }),
      ).toEqual(await render(selection));
    });

    it("preserves the original local Compose entry point", async () => {
      expect(await render(["compose"])).toEqual(
        await render(["compose.base", "compose.postgres", "compose.s3", "compose.rustfs"]),
      );
    });

    it("keeps telemetry private and grants only management access to its network", async () => {
      const { services } = await render(["compose.base", "compose.azure", "compose.telemetry"], {
        ...installationSettings,
        CLICKHOUSE_READ_PASSWORD: "fixture-reader-only",
        CLICKHOUSE_INGEST_PASSWORD: "fixture-ingest-only",
      });

      const control = serviceSchema.parse(services["control-plane"]);

      expect(Object.keys(control.networks).sort()).toEqual(["edge", "management", "telemetry"]);
      expect(control.environment["CLICKHOUSE_PASSWORD"]).toBe("fixture-reader-only");
      expect(control.environment["CLICKHOUSE_INGEST_PASSWORD"]).toBeUndefined();

      for (const name of ["clickhouse", "otel-collector"]) {
        expect(services[name]?.ports).toEqual([]);
        expect(Object.keys(services[name]?.networks ?? {})).toEqual(["telemetry"]);
      }

      expect(services["agent"]?.networks).not.toHaveProperty("telemetry");
      expect(services["proxy"]?.networks).not.toHaveProperty("telemetry");
    });

    it("passes selected credentials from an env file and mounts custom CA/credential files read-only", async () => {
      const { services } = await render(
        ["compose.base", "compose.azure", "compose.storage-credential", "compose.database-ca"],
        {
          ...installationSettings,
          AZURE_CLIENT_ID: installationSettings.ENTRA_CLIENT_ID,
          AZURE_TENANT_ID: installationSettings.ENTRA_TENANT_ID,
          AZURE_FEDERATED_TOKEN_FILE: "/run/widefleet/storage-credential",
          FLEET_CREDENTIAL_HOST_FILE: "/tmp/fixture-identity-token",
          DATABASE_CA_HOST_FILE: "/tmp/fixture-ca.pem",
        },
      );

      for (const name of ["control-plane", "agent"]) {
        const service = serviceSchema.parse(services[name]);
        expect(service.environment["AZURE_CLIENT_ID"]).toBe(installationSettings.ENTRA_CLIENT_ID);
        expect(service.environment["AZURE_STORAGE_ACCESS_KEY"] ?? undefined).toBeUndefined();
        expect(service.volumes).toContainEqual(
          expect.objectContaining({
            source: "/tmp/fixture-identity-token",
            target: "/run/widefleet/storage-credential",
            read_only: true,
          }),
        );
      }

      expect(services["agent"]?.environment["FLEET_CREDENTIAL_HOST_FILE"]).toBe(
        "/tmp/fixture-identity-token",
      );
      expect(services["control-plane"]?.volumes).toContainEqual(
        expect.objectContaining({
          source: "/tmp/fixture-ca.pem",
          target: "/run/secrets/postgres-ca.pem",
          read_only: true,
        }),
      );
    });
  },
);
