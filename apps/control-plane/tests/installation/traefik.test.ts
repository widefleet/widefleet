import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createCertificates } from "./certificates.ts";
import { installationSettings } from "./settings.ts";

const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

describe.runIf(process.env["RUN_INSTALLATION_TESTS"] === "1")(
  "Traefik certificate persistence",
  () => {
    it.each(["provided", "cloudflare"])(
      "serves management and wildcard certificates in %s mode across restart",
      async (mode) => {
        const directory = await mkdtemp(join(tmpdir(), "widefleet-traefik-tls-"));
        const name = `widefleet-traefik-tls-${randomUUID()}`;

        try {
          const certificates = await createCertificates(directory, ["*.notes.apps.example.test"]);
          await mkdir(join(directory, "tls"));
          await copyFile(certificates.certificate, join(directory, "tls/fullchain.pem"));
          await copyFile(certificates.key, join(directory, "tls/privkey.pem"));

          const configure = (stage: string) =>
            execute(process.execPath, ["apps/control-plane/tools/configure-edge.ts"], {
              cwd: root,
              env: {
                PATH: process.env["PATH"],
                HOME: process.env["HOME"],
                ...installationSettings,
                PLATFORM_DATA_DIRECTORY: directory,
                PLATFORM_CONFIG_DIRECTORY: join(directory, "config"),
                TLS_MODE: mode,
                ACME_ENVIRONMENT: stage,
              },
            });

          await configure("production");
          await writeFile(
            join(directory, "config/routes/preview.yaml"),
            JSON.stringify({
              http: {
                routers: {
                  preview: {
                    rule: "Host(`review.notes.apps.example.test`)",
                    entryPoints: ["websecure"],
                    service: "noop@internal",
                    tls:
                      mode === "cloudflare"
                        ? {
                            certResolver: "letsencrypt",
                            domains: [{ main: "*.notes.apps.example.test" }],
                          }
                        : {},
                  },
                },
              },
            }),
          );
          await mkdir(join(directory, "acme"), { recursive: true });

          const cached = JSON.stringify({
            letsencrypt: {
              Account: {
                Email: "operator@example.test",
                Registration: {
                  body: { status: "valid" },
                  uri: "https://acme.invalid/account/fixture",
                },
                PrivateKey: (await readFile(certificates.accountKey)).toString("base64"),
                KeyType: "RSA2048",
              },
              Certificates: [
                {
                  domain: { main: "platform.example.test", sans: ["*.apps.example.test"] },
                  certificate: (await readFile(certificates.certificate)).toString("base64"),
                  key: (await readFile(certificates.key)).toString("base64"),
                  Store: "default",
                },
                {
                  domain: { main: "*.notes.apps.example.test" },
                  certificate: (await readFile(certificates.certificate)).toString("base64"),
                  key: (await readFile(certificates.key)).toString("base64"),
                  Store: "default",
                },
              ],
            },
          });

          await writeFile(join(directory, "acme/production.json"), cached, { mode: 0o600 });
          await configure("production");
          expect(await readFile(join(directory, "acme/production.json"), "utf8")).toBe(cached);
          // Neither Traefik nor its TLS probe has external network access.
          await execute("docker", [
            "run",
            "-d",
            "--name",
            name,
            "--network=none",
            "--volume",
            `${directory}/config/traefik.json:/config/traefik.json:ro`,
            "--volume",
            `${directory}/config/routes:/config/routes:ro`,
            "--volume",
            `${directory}/tls:/tls:ro`,
            "--volume",
            `${directory}/acme:/acme`,
            "--env=CF_DNS_API_TOKEN=fixture-only",
            "traefik:v3.7.13@sha256:24841fe2de7304c149343d877d2923b4c8800a38ba015dea9174c23b20e344a0",
            "--configFile=/config/traefik.json",
          ]);

          for (let attempt = 0; attempt < 2; attempt++) {
            await vi.waitFor(
              () =>
                execute("docker", [
                  "run",
                  "--rm",
                  "--network",
                  `container:${name}`,
                  "--volume",
                  `${directory}:/fixtures:ro`,
                  "node:26.8.2-bookworm-slim",
                  "node",
                  "--input-type=module",
                  "--eval",
                  `import { connect } from "node:tls";
           import { readFileSync } from "node:fs";
           for (const servername of ["platform.example.test", "notes.apps.example.test", "auth.apps.example.test", "review.notes.apps.example.test", "another.notes.apps.example.test"]) {
             await new Promise((resolve, reject) => {
               const socket = connect({ host: "127.0.0.1", port: 8443, servername, ca: readFileSync("/fixtures/ca.pem") }, () => { socket.end(); resolve(); });
               socket.setTimeout(3000, () => socket.destroy(new Error("TLS handshake timed out")));
               socket.once("error", reject);
             });
           }`,
                ]),
              { timeout: 15_000 },
            );

            if (attempt === 0) await execute("docker", ["restart", name]);
          }

          if (mode === "cloudflare") {
            await configure("staging");
            expect(await readFile(join(directory, "config/traefik.json"), "utf8")).toContain(
              "/acme/staging.json",
            );
            expect(await readFile(join(directory, "acme/production.json"), "utf8")).toContain(
              "Certificates",
            );
          }
        } finally {
          await execute("docker", ["rm", "-f", name]).catch(() => undefined);
          await rm(directory, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
