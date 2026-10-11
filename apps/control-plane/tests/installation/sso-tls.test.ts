import { build } from "esbuild";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { activationStatus, companyProvider } from "@platform/contracts";
import { appSsoConfiguration } from "../../tools/edge-configuration.ts";
import { createCertificates } from "./certificates.ts";

const execute = promisify(execFile);

const docker = (...args: string[]) => execute("docker", args);

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")("Packaged SSO TLS", () => {
  it("ships public roots and verifies HTTPS discovery against the system trust store", async () => {
    const name = `widefleet-sso-tls-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), "widefleet-sso-tls-"));
    const image = process.env["PLATFORM_SSO_IMAGE"] ?? "widefleet-sso:setup-check";
    const fixture = join(directory, "provider.mjs");

    const provider = companyProvider.parse({
      type: "oidc",
      issuer: "https://localhost:4182",
      label: "Test",
    });

    const bundle = {
      proxy: appSsoConfiguration(provider, "test-client", "/runtime/client-secret"),
      clientSecret: "test-secret",
      cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/callback",
    };

    const node = (...args: string[]) => docker("exec", name, "node", ...args);

    const inspect = async () => {
      const result = await node(
        "--input-type=module",
        "--eval",
        'import {readFile} from "node:fs/promises"; console.log(await readFile("/auth/status.json", "utf8"));',
      );

      return activationStatus.parse(JSON.parse(result.stdout));
    };

    const publish = (revision: string) =>
      node(
        "--input-type=module",
        "--eval",
        'import {writeFile,rename} from "node:fs/promises"; await writeFile("/auth/desired.tmp", process.argv[1], {mode:384}); await rename("/auth/desired.tmp", "/auth/desired.json");',
        JSON.stringify({ ...bundle, revision }),
      );

    try {
      const certificates = await createCertificates(directory);
      await build({
        entryPoints: [fileURLToPath(new URL("rotation-provider.ts", import.meta.url))],
        outfile: fixture,
        bundle: true,
        platform: "node",
        format: "esm",
      });
      await docker("run", "-d", "--name", name, "--network=none", image);
      await vi.waitFor(async () => expect((await inspect()).state).toBe("waiting"));

      // Check the unmodified image before installing any synthetic trust anchor.
      // Node's bundled roots cannot stand in for the OS roots used by the Go proxy.
      const roots = await node(
        "--input-type=module",
        "--eval",
        'import {getCACertificates} from "node:tls"; console.log(getCACertificates("system").length);',
      );

      expect(z.coerce.number().parse(roots.stdout)).toBeGreaterThan(0);

      await docker("cp", fixture, `${name}:/runtime/provider.mjs`);
      await docker("cp", certificates.certificate, `${name}:/runtime/server.pem`);
      await docker("cp", certificates.key, `${name}:/runtime/server.key`);
      await docker("exec", "--user=root", name, "chown", "node:node", "/runtime/server.key");
      await docker(
        "exec",
        "-d",
        "--env=OIDC_TLS_DIRECTORY=/runtime",
        name,
        "node",
        "/runtime/provider.mjs",
      );
      await vi.waitFor(async () => {
        await node(
          "--input-type=module",
          "--eval",
          'import {connect} from "node:net"; const socket=connect(4182,"127.0.0.1",()=>socket.end()); socket.on("error",()=>process.exit(1));',
        );
      });

      await publish("untrusted");
      await vi.waitFor(
        async () =>
          expect(await inspect()).toMatchObject({ revision: "untrusted", state: "failed" }),
        { timeout: 15_000 },
      );
      const logs = await docker("logs", name);
      expect(logs.stdout + logs.stderr).toContain("certificate signed by unknown authority");

      // Extend the image's real trust store, keeping discovery and TLS verification enabled.
      await docker("cp", certificates.ca, `${name}:/runtime/test-ca.pem`);
      await docker(
        "exec",
        "--user=root",
        name,
        "node",
        "--input-type=module",
        "--eval",
        'import {appendFile,readFile} from "node:fs/promises"; await appendFile("/etc/ssl/certs/ca-certificates.crt", await readFile("/runtime/test-ca.pem"));',
      );
      await publish("trusted");
      await vi.waitFor(
        async () => expect(await inspect()).toMatchObject({ revision: "trusted", state: "active" }),
        { timeout: 15_000 },
      );
      await node(
        "--eval",
        'fetch("http://127.0.0.1:4180/ready").then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1));',
      );
    } finally {
      await docker("rm", "--force", name).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
