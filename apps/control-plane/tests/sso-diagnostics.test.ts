import { describe, expect, it } from "vitest";
import { ssoFailureReason } from "../tools/sso-diagnostics.ts";

describe("Safe SSO activation diagnostics", () => {
  it.each([
    ["x509: certificate signed by unknown authority", "CA certificates"],
    ["x509: certificate has expired or is not yet valid", "validity dates"],
    ["x509: certificate is valid for other.example.test, not issuer.example.test", "hostname"],
    ["lookup issuer.example.test: no such host", "DNS configuration"],
    ["dial tcp 127.0.0.1:4181: connect: connection refused", "firewall rules"],
    [
      "context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
      "did not respond in time",
    ],
    ["oidc: issuer did not match the issuer returned by provider", "exact issuer"],
    ["cookie_secret must be 16, 24, or 32 bytes to create an AES cipher", "cookie secret"],
  ])("classifies %s without copying diagnostic text", (diagnostic, guidance) => {
    const output = `client_secret=fixture-client-secret cookie=fixture-cookie-secret\nGet "https://private.example.test/?token=fixture-access-token": ${diagnostic}`;

    for (const phase of ["validation", "startup"] as const) {
      const message = ssoFailureReason(output, phase);
      expect(message).toContain(guidance);
      expect(message).not.toMatch(/fixture-|example\.test|client_secret=/);
    }
  });

  it("uses a safe phase-specific fallback for arbitrary provider output", () => {
    const output = "<script>fixture-secret</script> provider said: password=fixture-password";
    expect(ssoFailureReason(output, "validation")).toBe(
      "The sign-in configuration is invalid. Check the provider settings and the SSO container configuration, then save again.",
    );
    expect(ssoFailureReason(output, "startup")).toBe(
      "The sign-in service could not start. Check the provider settings and the SSO container logs, then save again.",
    );
  });
});
