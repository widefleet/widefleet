import { describe, expect, it, vi } from "vitest";
import worker from "./worker.ts";
import { authControlPath } from "./publication.ts";

describe("Auth proxy diagnostics", () => {
  it.each(["configuration", "control"])("logs only the %s failure category", async (phase) => {
    const key = "local-auth-proxy-control-key-never-deploy";
    const privateValue = "private-client-secret-cookie-and-token";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const environment = {
      AUTH_PROXY_KEY: key,
      get AUTH_CONFIG(): never {
        throw new Error(privateValue);
      },
    };

    try {
      const request =
        phase === "control"
          ? new Request(`https://auth.apps.example.test${authControlPath}/configuration`, {
              method: "PUT",
              headers: { authorization: `Bearer ${key}` },
              body: JSON.stringify({ clientSecret: privateValue }),
            })
          : new Request("https://notes.apps.example.test/");

      const response = await worker.fetch(request, environment);
      expect(response.status).toBe(503);
      expect(log.mock.calls).toEqual([["Auth proxy operation failed", { phase }]]);
      expect(await response.text()).not.toContain(privateValue);
    } finally {
      log.mockRestore();
    }
  });
});
