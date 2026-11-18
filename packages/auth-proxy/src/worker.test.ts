import { describe, expect, it, vi } from "vitest";
import { Miniflare, type RequestInit as WorkerRequestInit } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authConfiguration } from "./configuration.ts";
import { mcpOrganizationKey } from "./mcp-login.ts";
import { createAuthHandler, manageAuthConfiguration } from "./worker.ts";
import { authConfigurationKey, authControlPath } from "./publication.ts";

it("revokes only the selected organization's sign-in and MCP discovery entry", async () => {
  const key = "local-auth-proxy-control-key-never-deploy";

  const compiled = await build({
    stdin: {
      contents: `import {createAuthHandler} from './worker.ts';
        export default {fetch(request,env){
          return createAuthHandler(env,async()=>new Response('App')).fetch(request);
        }};`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    external: ["node:*"],
  });

  const runtime = new Miniflare({
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "auth-storage",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: z.string().parse(compiled.outputFiles[0]?.text),
              },
            },
          },
          env: {
            AUTH_CONFIG: { type: "kv", id: "auth" },
            WIDEFLEET_CONTROL_TOKEN: { type: "json", value: key },
          },
        },
      },
    ],
  });

  try {
    const storage = await runtime.getKVNamespace("AUTH_CONFIG");

    const control = (path: string, method: string, body?: string, authorized = true) => {
      const options: WorkerRequestInit = {
        method,
        headers: authorized ? { authorization: `Bearer ${key}` } : {},
      };

      if (body !== undefined) options.body = body;

      return runtime.dispatchFetch(
        `https://auth.apps.example.test${authControlPath}/${path}`,
        options,
      );
    };

    for (const organizationId of ["revoked", "retained"]) {
      const configuration = authConfiguration.parse({
        organizationId,
        provider: { type: "google", domain: "example.test" },
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: `https://auth.apps.example.test/oauth2/${organizationId}/callback`,
      });

      expect(
        (await control(authConfigurationKey(organizationId), "PUT", JSON.stringify(configuration)))
          .status,
      ).toBe(204);
      const lookup = mcpOrganizationKey(configuration);

      if (!lookup) throw new Error("Expected a Google organization lookup");
      expect(await storage.get(lookup)).toBe(organizationId);
    }

    expect(
      (
        await control(
          "apps/ledger.apps.example.test",
          "PUT",
          JSON.stringify({
            organizationId: "revoked",
            appId: "00000000-0000-4000-8000-000000000003",
            access: { revision: 1, groups: [] },
          }),
        )
      ).status,
    ).toBe(204);
    const configurationKey = authConfigurationKey("revoked");
    expect((await control(configurationKey, "DELETE", undefined, false)).status).toBe(403);
    expect(await storage.get(configurationKey)).not.toBeNull();
    expect((await control(configurationKey, "DELETE")).status).toBe(204);
    expect((await control(configurationKey, "DELETE")).status).toBe(204);
    expect(await storage.get(configurationKey)).toBeNull();
    expect(await storage.get("mcp/organizations/google/example.test/revoked")).toBeNull();
    expect(await storage.get(authConfigurationKey("retained"))).not.toBeNull();
    expect(await storage.get("mcp/organizations/google/example.test/retained")).toBe("retained");
    expect(await (await control(configurationKey, "GET")).json()).toMatchObject({
      state: "waiting",
    });
    expect((await runtime.dispatchFetch("https://ledger.apps.example.test/")).status).toBe(503);

    for (const action of ["start", "callback"])
      expect(
        (await runtime.dispatchFetch(`https://auth.apps.example.test/oauth2/revoked/${action}`))
          .status,
      ).toBe(404);
  } finally {
    await runtime.dispose();
  }
});

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
