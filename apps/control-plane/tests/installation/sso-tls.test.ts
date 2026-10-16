import { describe, expect, it } from "vitest";
import { installedAuth, docker } from "./installed-auth.ts";
import { createCertificates } from "./certificates.ts";

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")("Packaged auth proxy TLS", () => {
  it("ships trusted roots and rejects an untrusted identity provider certificate", async () => {
    const fixture = await installedAuth();

    try {
      await fixture.start();
      const certificates = await createCertificates(fixture.directory);
      await docker("exec", fixture.name, "test", "-s", "/etc/ssl/certs/ca-certificates.crt");
      await docker("cp", certificates.certificate, `${fixture.client}:/runtime/server.pem`);
      await docker("cp", certificates.key, `${fixture.client}:/runtime/server.key`);
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
        "sh",
        "-c",
        "cat /runtime/test-ca.pem >> /etc/ssl/certs/ca-certificates.crt",
      );
      await fixture.restart();
      await fixture.trustProviderCertificate(certificates.ca);
      await docker("cp", certificates.certificate, `${fixture.client}:/runtime/server.pem`);
      await docker("cp", certificates.key, `${fixture.client}:/runtime/server.key`);
      await fixture.startProvider(true);
      expect((await fixture.login()).location).toBe("https://notes.apps.example.test/");
    } finally {
      await fixture.dispose();
    }
  }, 120_000);
});
