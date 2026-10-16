import { describe, expect, it, vi } from "vitest";
import { createAuthHandler } from "./worker.ts";
import { authControlPath } from "./publication.ts";

describe("Auth proxy diagnostics", () => {
  it.each(["configuration", "control"])("logs only the %s failure category", async (phase) => {
    const key = "local-auth-proxy-control-key-never-deploy";
    const privateValue = "private-client-secret-cookie-and-token";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const environment = {
      WIDEFLEET_CONTROL_TOKEN: key,
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

      const response = await createAuthHandler(environment, async () => new Response("App")).fetch(
        request,
      );

      expect(response.status).toBe(503);
      expect(log.mock.calls).toEqual([["Auth proxy operation failed", { phase }]]);
      expect(await response.text()).not.toContain(privateValue);
    } finally {
      log.mockRestore();
    }
  });
});
