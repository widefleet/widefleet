import { sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configurationSchema } from "../../src/lib/server/config.ts";
import { createDatabase } from "../../src/lib/server/database.ts";
import { oauthClient } from "../../src/lib/server/auth-schema.ts";
import { createCertificates } from "./certificates.ts";
import { installationSettings } from "./settings.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe.runIf(process.env["RUN_INSTALLATION_TESTS"] === "1")(
  "external PostgreSQL with verified TLS",
  () => {
    const name = `widefleet-postgres-tls-${randomUUID()}`;
    let directory = "";
    let databaseUrl = "";

    const connect = (url: string) =>
      createDatabase(
        configurationSchema.parse({
          ...installationSettings,
          DATABASE_URL: url,
          S3_ENDPOINT: "http://127.0.0.1:1",
          S3_BUCKET: "fixture-artifacts",
        }),
      );

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "widefleet-postgres-tls-"));
      const certificates = await createCertificates(directory);
      await writeFile(
        join(directory, "pg_hba.conf"),
        "local all all trust\nhostnossl all all all reject\nhostssl all all all scram-sha-256\n",
      );
      await execute("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--publish=127.0.0.1::5432",
        "--volume",
        `${directory}:/fixtures:ro`,
        "--tmpfs=/var/lib/postgresql",
        "--env=POSTGRES_USER=fixture",
        "--env=POSTGRES_DB=platform",
        "--env=POSTGRES_PASSWORD=fixture-only",
        "postgres:18.1",
        "bash",
        "-c",
        "cp /fixtures/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/fixtures/server.pem -c ssl_key_file=/tmp/server.key -c hba_file=/fixtures/pg_hba.conf",
      ]);

      const port = (await execute("docker", ["port", name, "5432/tcp"])).stdout
        .trim()
        .split(":")
        .at(-1);

      const url = new URL(`postgres://fixture:fixture-only@localhost:${port}/platform`);
      url.searchParams.set("sslmode", "verify-full");
      url.searchParams.set("sslrootcert", certificates.ca);
      databaseUrl = url.href;
      await vi.waitFor(
        async () => {
          const database = connect(databaseUrl);

          try {
            await database.db.execute(sql`SELECT 1`);
          } finally {
            await database.close();
          }
        },
        { timeout: 20_000 },
      );
    }, 45_000);

    afterAll(async () => {
      await execute("docker", ["rm", "-f", name]).catch(() => undefined);

      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("runs the real initialization twice over verified TLS", async () => {
      for (let attempt = 0; attempt < 2; attempt++)
        await execute(process.execPath, ["apps/control-plane/tools/initialize.ts"], {
          cwd: root,
          env: {
            PATH: process.env["PATH"],
            HOME: process.env["HOME"],
            ...installationSettings,
            DATABASE_URL: databaseUrl,
            PLATFORM_STATE_DIRECTORY: join(directory, "state"),
            PLATFORM_AUTH_DIRECTORY: join(directory, "auth"),
            S3_ENDPOINT: "http://127.0.0.1:1",
            S3_BUCKET: "fixture-artifacts",
          },
        });
      const database = connect(databaseUrl);

      try {
        expect(
          (await database.db.execute(sql`SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`))
            .rows,
        ).toEqual([{ ssl: true }]);
        expect(await database.db.select().from(oauthClient)).toHaveLength(1);
      } finally {
        await database.close();
      }
    }, 20_000);

    it.each(["untrusted", "hostname", "plaintext"])("rejects %s connections", async (mode) => {
      const url = new URL(databaseUrl);

      if (mode === "untrusted") url.searchParams.delete("sslrootcert");

      if (mode === "hostname") url.hostname = "127.0.0.1";

      if (mode === "plaintext") url.searchParams.set("sslmode", "disable");
      const database = connect(url.href);

      try {
        await expect(database.db.execute(sql`SELECT 1`)).rejects.toThrow();
      } finally {
        await database.close();
      }
    });
  },
);
