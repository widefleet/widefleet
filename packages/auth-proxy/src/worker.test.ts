import { describe, expect, it, vi } from "vitest";
import { createAuthHandler, manageAuthConfiguration } from "./worker.ts";
import { authControlPath } from "./publication.ts";

describe("Auth proxy diagnostics", () => {
  it("rejects private configuration writes without a usable encryption key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const storage = vi.fn((): never => {
      throw new Error("Must not access storage without the encryption key");
    });

    try {
      const response = await manageAuthConfiguration(
        new Request(
          `https://auth.invalid${authControlPath}/organizations/widefleet/configuration`,
          { method: "PUT" },
        ),
        {
          WIDEFLEET_CONTROL_TOKEN: "",
          get AUTH_CONFIG(): never {
            return storage();
          },
        },
      );

      expect(response.status).toBe(503);
      expect(storage).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([["Auth proxy operation failed", { phase: "control" }]]);
    } finally {
      log.mockRestore();
    }
  });

  it.each(["app-route", "control"])("logs only the %s failure category", async (phase) => {
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
          ? new Request(
              `https://auth.apps.example.test${authControlPath}/organizations/widefleet/configuration`,
              {
                method: "PUT",
                headers: { authorization: `Bearer ${key}` },
                body: JSON.stringify({ clientSecret: privateValue }),
              },
            )
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
