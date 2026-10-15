import { describe, expect, it, vi } from "vitest";
import { installedAuth, docker } from "./installed-auth.ts";
import { createCertificates } from "./certificates.ts";

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")("Packaged auth proxy TLS", () => {
  it("ships trusted roots and rejects an untrusted identity provider certificate", async () => {
    const fixture = await installedAuth();

    try {
      await fixture.start();
      const certificates = await createCertificates(fixture.directory);
      expect(
        Number(
          await fixture.node(
            'import {getCACertificates} from "node:tls"; console.log(getCACertificates("system").length);',
          ),
        ),
      ).toBeGreaterThan(0);
      await docker("cp", certificates.certificate, `${fixture.name}:/runtime/server.pem`);
      await docker("cp", certificates.key, `${fixture.name}:/runtime/server.key`);
      await docker(
        "exec",
        "--user=root",
        fixture.name,
        "chown",
        "node:node",
        "/runtime/server.key",
      );
      await fixture.startProvider(true);
      await fixture.publish({
        ...fixture.configuration,
        provider: {
          type: "oidc",
          issuer: "https://localhost:4181",
          label: "Test",
          groupsClaim: "groups",
          nameClaim: "name",
          emailClaim: "email",
        },
      });
      await fixture.route([]);
      expect((await fixture.login()).status).toBe(503);
      await docker("cp", certificates.ca, `${fixture.name}:/runtime/test-ca.pem`);
      await docker(
        "exec",
        "--user=root",
        fixture.name,
        "node",
        "--input-type=module",
        "--eval",
        'import {appendFile,readFile} from "node:fs/promises"; await appendFile("/etc/ssl/certs/ca-certificates.crt",await readFile("/runtime/test-ca.pem"));',
      );
      await docker("restart", "--time", "45", fixture.name);
      await vi.waitFor(async () => expect((await fixture.inspect()).status.state).toBe("active"), {
        timeout: 30_000,
      });
      await fixture.startProvider(true);
      expect((await fixture.login()).location).toBe("https://notes.apps.example.test/");
    } finally {
      await fixture.dispose();
    }
  }, 120_000);
});
