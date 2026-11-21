import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import App, { UserConnection } from "../src/app.ts";
import type { OAuthBinding } from "../src/oauth.ts";
import type { Environment, Properties } from "../src/context.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

interface TestEnvironment extends Omit<Environment, "WIDEFLEET_SECRETS" | "WIDEFLEET_KEYS"> {
  TEST_OAUTH?: {
    request(
      caller: NonNullable<Properties["caller"]>,
      input: Parameters<OAuthBinding["request"]>[0],
    ): ReturnType<OAuthBinding["request"]>;
  };
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
}

const encoder = new TextEncoder();

// Stands in for the runtime's key binding with a fixed synthetic key.
const testKey = (algorithm: "AES-GCM" | "HMAC") =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode("synthetic-key-of-thirty-two-byte"),
    algorithm === "HMAC" ? { name: "HMAC", hash: "SHA-256" } : algorithm,
    false,
    algorithm === "HMAC" ? ["sign", "verify"] : ["encrypt", "decrypt"],
  );

const keys: Environment["WIDEFLEET_KEYS"] = {
  sign: async (name, data) =>
    btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            await testKey("HMAC"),
            encoder.encode(`${name}:${data}`),
          ),
        ),
      ),
    ),
  verify: async (name, data, signature) =>
    crypto.subtle.verify(
      "HMAC",
      await testKey("HMAC"),
      Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)),
      encoder.encode(`${name}:${data}`),
    ),
  encrypt: async (name, data) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      await testKey("AES-GCM"),
      encoder.encode(data),
    );

    return `v1.${btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed)))}`;
  },
  decrypt: async (name, ciphertext) => {
    const bytes = Uint8Array.from(atob(ciphertext.slice(3)), (character) =>
      character.charCodeAt(0),
    );

    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(name) },
        await testKey("AES-GCM"),
        bytes.slice(12),
      ),
    );
  },
};

const testEnvironment = (ctx: ExecutionContext<Properties>, env: TestEnvironment): Environment => ({
  ...env,
  WIDEFLEET_KEYS: keys,
  WIDEFLEET_OAUTH: {
    request: async (input) => {
      if (!env.TEST_OAUTH) return null;

      if (!ctx.props.caller) throw new Error("Caller required");

      return env.TEST_OAUTH.request(ctx.props.caller, input);
    },
  },
  WIDEFLEET_SECRETS: {
    get: async (name) => {
      const value = env[z.enum(["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]).parse(name)];

      if (!value) throw new Error("App secret is not configured");

      return value;
    },
  },
});

export class TestApp extends App {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, testEnvironment(ctx, env));
  }
}

export class TestUserConnection extends UserConnection {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, testEnvironment(ctx, env));
  }
}

// Widefleet supplies these props after verifying the signed-in caller.
export default class Host extends WorkerEntrypoint<TestEnvironment> {
  override async fetch(request: Request) {
    const subject = request.headers.get("test-subject");

    const options = {
      props: {
        caller: subject
          ? {
              issuer: request.headers.get("test-issuer") ?? "https://identity.example.test",
              subject,
              name: subject,
            }
          : null,
      },
    };

    const app = this.ctx.exports.TestApp(options);
    const connection = this.ctx.exports.TestUserConnection(options);

    const path = new URL(request.url).pathname;

    if (path === "/rpc/personal/status") return Response.json(await connection.status());

    if (path === "/rpc/personal/prepare")
      return Response.json(
        await connection.prepare(z.object({ completionUrl: z.url() }).parse(await request.json())),
      );

    if (path === "/rpc/personal/disconnect") return Response.json(await connection.disconnect());

    if (path === "/rpc/status") return Response.json(await app.connectionStatus());

    if (path === "/rpc/list") return Response.json(await app.listIssues());

    if (path === "/rpc/teams") return Response.json(await app.listTeams({ query: "eng" }));

    if (path === "/rpc/mine")
      return Response.json(await app.listIssues({ assignee: "me", state: "started", limit: 10 }));

    if (path === "/rpc/issue") return Response.json(await app.getIssue({ id: "ENG-7" }));

    return app.fetch(request);
  }
}
