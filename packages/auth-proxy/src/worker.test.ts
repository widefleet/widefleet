import { describe, expect, it, vi } from "vitest";
import { Miniflare, type RequestInit as WorkerRequestInit } from "miniflare";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authConfiguration } from "./configuration.ts";
import { mcpDomainKeys, mcpDomainPrefix, mcpOrganizationKey } from "./mcp-login.ts";
import { createAuthHandler, manageAuthConfiguration } from "./worker.ts";
import { authConfigurationKey, authControlPath } from "./publication.ts";

it("revokes only the selected organization's sign-in and MCP discovery entries", async () => {
  const key = "local-auth-proxy-control-key-never-deploy";

  const compiled = await build({
    stdin: {
      // A test header makes writing or deleting one KV key fail, as a transient storage error would.
      contents: `import {createAuthHandler} from './worker.ts';
        export default {fetch(request,env){
          const failing=request.headers.get('x-test-failing-key');
          const storage=failing ? new Proxy(env.AUTH_CONFIG,{get(target,name){
            if(name==='put'||name==='delete') return async(key,...rest)=>{ if(key===failing) throw new Error('Synthetic KV failure'); return target[name](key,...rest); };
            const value=target[name]; return typeof value==='function' ? value.bind(target) : value;
          }}) : env.AUTH_CONFIG;
          return createAuthHandler({...env,AUTH_CONFIG:storage},async()=>new Response('App')).fetch(request);
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

    const control = (
      path: string,
      method: string,
      body?: string,
      authorized = true,
      failingKey?: string,
    ) => {
      const headers: Record<string, string> = {};

      if (authorized) headers["authorization"] = `Bearer ${key}`;

      if (failingKey) headers["x-test-failing-key"] = failingKey;
      const options: WorkerRequestInit = { method, headers };

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
        emailDomains: [`${organizationId}.example`, "shared.example"],
      });

      expect(
        (await control(authConfigurationKey(organizationId), "PUT", JSON.stringify(configuration)))
          .status,
      ).toBe(204);
      const lookup = mcpOrganizationKey(configuration);

      if (!lookup) throw new Error("Expected a Google organization lookup");
      expect(await storage.get(lookup)).toBe(organizationId);

      for (const key of mcpDomainKeys(configuration))
        expect(await storage.get(key)).toBe(organizationId);
    }

    // Republishing without a domain removes only that organization's entry for it.
    const narrowed = authConfiguration.parse({
      organizationId: "retained",
      provider: { type: "google", domain: "example.test" },
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/retained/callback",
      emailDomains: ["retained.example"],
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dropped = `${mcpDomainPrefix("shared.example")}retained`;

    // The discovery list keeps a key whose removal failed, so the retry removes it.
    expect(
      (
        await control(
          authConfigurationKey("retained"),
          "PUT",
          JSON.stringify(narrowed),
          true,
          dropped,
        )
      ).status,
    ).toBe(503);
    expect(await storage.get(dropped)).toBe("retained");
    expect(
      (await control(authConfigurationKey("retained"), "PUT", JSON.stringify(narrowed))).status,
    ).toBe(204);
    expect(await storage.get(`${mcpDomainPrefix("shared.example")}retained`)).toBeNull();
    expect(await storage.get(`${mcpDomainPrefix("shared.example")}revoked`)).toBe("revoked");
    expect(await storage.get(`${mcpDomainPrefix("retained.example")}retained`)).toBe("retained");

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
    // Like an organization published before discovery lists existed.
    await storage.delete("organizations/revoked/discovery");
    expect(
      (
        await control(
          configurationKey,
          "DELETE",
          undefined,
          true,
          `${mcpDomainPrefix("shared.example")}revoked`,
        )
      ).status,
    ).toBe(503);
    // Sign-in is revoked even though index cleanup failed; the retry removes the rest.
    expect(await storage.get(configurationKey)).toBeNull();
    expect((await runtime.dispatchFetch("https://ledger.apps.example.test/")).status).toBe(503);
    expect(await storage.get(`${mcpDomainPrefix("shared.example")}revoked`)).toBe("revoked");
    // Its derived list is gone with the configuration, so the remaining key is saved.
    expect(
      JSON.parse(z.string().parse(await storage.get("organizations/revoked/discovery"))),
    ).toEqual([`${mcpDomainPrefix("shared.example")}revoked`]);
    expect((await control(configurationKey, "DELETE")).status).toBe(204);
    expect(await storage.get("organizations/revoked/discovery")).toBeNull();
    expect((await control(configurationKey, "DELETE")).status).toBe(204);
    expect(await storage.get(configurationKey)).toBeNull();
    expect(await storage.get("mcp/organizations/google/example.test/revoked")).toBeNull();
    expect(await storage.get(authConfigurationKey("retained"))).not.toBeNull();
    expect(await storage.get("mcp/organizations/google/example.test/retained")).toBe("retained");
    expect(await storage.get(`${mcpDomainPrefix("revoked.example")}revoked`)).toBeNull();
    expect(await storage.get(`${mcpDomainPrefix("shared.example")}revoked`)).toBeNull();
    expect(await storage.get(`${mcpDomainPrefix("retained.example")}retained`)).toBe("retained");
    expect(await (await control(configurationKey, "GET")).json()).toMatchObject({
      state: "waiting",
    });
    expect((await runtime.dispatchFetch("https://ledger.apps.example.test/")).status).toBe(503);

    for (const action of ["start", "callback"])
      expect(
        (await runtime.dispatchFetch(`https://auth.apps.example.test/oauth2/revoked/${action}`))
          .status,
      ).toBe(404);

    // Keys from a failed first publication are listed before they are written,
    // so revoking the organization removes them.
    const stranded = authConfiguration.parse({
      organizationId: "stranded",
      provider: { type: "google", domain: "stranded.example" },
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
      domain: "apps.example.test",
      redirectUrl: "https://auth.apps.example.test/oauth2/stranded/callback",
      emailDomains: ["first.example", "second.example"],
    });

    const [written, failed] = mcpDomainKeys(stranded);

    if (!written || !failed) throw new Error("Expected two domain keys");
    expect(
      (
        await control(
          authConfigurationKey("stranded"),
          "PUT",
          JSON.stringify(stranded),
          true,
          failed,
        )
      ).status,
    ).toBe(503);
    expect(await storage.get(written)).toBe("stranded");
    expect((await control(authConfigurationKey("stranded"), "DELETE")).status).toBe(204);

    for (const key of [written, failed, "mcp/organizations/google/stranded.example/stranded"])
      expect(await storage.get(key)).toBeNull();
    expect(await storage.get("organizations/stranded/discovery")).toBeNull();
    error.mockRestore();
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
