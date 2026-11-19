import { afterEach, describe, expect, it, vi } from "vitest";
import { base64url } from "jose";
import { z } from "zod";
import {
  mcpCliLoginLifetime,
  mcpCliLoginOrganization,
  signMcpCliLogin,
  verifyMcpCliLogin,
} from "./mcp-cli-login.ts";
import { authControlPath } from "./publication.ts";
import { createAuthHandler } from "./worker.ts";

const key = "local-mcp-cli-login-key-never-deploy";

const login = {
  organizationId: "widefleet",
  issuer: "https://login.example.test/tenant/v2.0",
  subject: "synthetic-subject",
};

describe("MCP CLI login codes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies its own codes until they expire", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const code = await signMcpCliLogin(key, login);

    expect(mcpCliLoginOrganization(code)).toBe("widefleet");
    expect(await verifyMcpCliLogin(key, code)).toMatchObject({
      ...login,
      purpose: "widefleet-mcp-cli-login/v1",
      expiresAt: 1_800_000_000_000 + mcpCliLoginLifetime,
    });

    vi.setSystemTime(1_800_000_000_000 + mcpCliLoginLifetime);
    expect(await verifyMcpCliLogin(key, code)).toBeNull();
  });

  it("gives every code its own identifier", async () => {
    const [first, second] = await Promise.all([
      signMcpCliLogin(key, login),
      signMcpCliLogin(key, login),
    ]);

    expect((await verifyMcpCliLogin(key, first))?.id).not.toBe(
      (await verifyMcpCliLogin(key, second))?.id,
    );
  });

  it("rejects other keys, changed claims and malformed input", async () => {
    const code = await signMcpCliLogin(key, login);
    const [payload, signature] = code.split(".");

    const claims = z
      .record(z.string(), z.json())
      .parse(JSON.parse(new TextDecoder().decode(base64url.decode(payload ?? ""))));

    const forged = base64url.encode(JSON.stringify({ ...claims, subject: "someone-else" }));

    expect(await verifyMcpCliLogin("another-local-key-that-is-long-enough", code)).toBeNull();
    expect(await verifyMcpCliLogin(key, `${forged}.${signature}`)).toBeNull();
    expect(await verifyMcpCliLogin(key, "not-a-code")).toBeNull();
    expect(await verifyMcpCliLogin(key, "")).toBeNull();
    expect(mcpCliLoginOrganization("not-a-code")).toBeNull();
  });

  it("verifies codes only through the authorized control channel", async () => {
    const environment = {
      WIDEFLEET_CONTROL_TOKEN: key,
      get AUTH_CONFIG(): never {
        throw new Error("Verification must not read KV");
      },
    };

    const handler = createAuthHandler(environment, async () => new Response("App"));

    const verify = (code: string, authorization = `Bearer ${key}`) =>
      handler.fetch(
        new Request(`https://auth.apps.example.test${authControlPath}/mcp/cli-login`, {
          method: "POST",
          headers: { authorization },
          body: JSON.stringify({ code }),
        }),
      );

    const code = await signMcpCliLogin(key, login);
    const verified = await verify(code);

    expect(verified.status).toBe(200);
    expect(verified.headers.get("cache-control")).toBe("no-store");
    expect(await verified.json()).toMatchObject({ login });
    expect(await (await verify("not-a-code")).json()).toEqual({ login: null });
    expect((await verify(code, "Bearer wrong")).status).toBe(403);
  });
});
