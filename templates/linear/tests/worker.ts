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

// The methods these tests call, as a consuming app declares them. Cloudflare's
// RPC types for the loopback binding fail on recursive JSON results (TS2589,
// cloudflare/workerd#3063).
type Binding = Pick<
  TestApp,
  | "connectionStatus"
  | "listIssues"
  | "saveIssue"
  | "deleteComment"
  | "extractImages"
  | "getWorkspace"
  | "fetch"
>;

// Widefleet supplies these props after verifying the signed-in caller, and the
// user's answer when it calls a method again after a question.
export default class Host extends WorkerEntrypoint<TestEnvironment> {
  override async fetch(request: Request) {
    const subject = request.headers.get("test-subject");
    const answer = request.headers.get("test-answer");

    const caller = subject
      ? {
          issuer: request.headers.get("test-issuer") ?? "https://identity.example.test",
          subject,
          name: subject,
        }
      : null;

    const input = answer
      ? {
          inputResponses: { approve: { action: z.enum(["accept", "decline"]).parse(answer) } },
        }
      : undefined;

    const stub: unknown = this.ctx.exports.TestApp(
      input ? { props: { caller, input } } : { props: { caller } },
    );

    // SAFETY: TestApp implements every Binding method; the loopback stub calls
    // them over RPC with the same arguments and results.
    const app = stub as Binding;
    const connection = this.ctx.exports.TestUserConnection({ props: { caller } });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/rpc/personal/status") return Response.json(await connection.status());

    if (path === "/rpc/personal/prepare")
      return Response.json(
        await connection.prepare(z.object({ completionUrl: z.url() }).parse(await request.json())),
      );

    if (path === "/rpc/personal/disconnect") return Response.json(await connection.disconnect());

    if (path === "/rpc/status") return Response.json(await app.connectionStatus());

    if (path === "/rpc/list") return Response.json(await app.listIssues({ assignee: "me" }));

    if (path === "/rpc/workspace") return Response.json(await app.getWorkspace());

    // Linear allows at most 250 results per page.
    if (path === "/rpc/invalid") return Response.json(await app.listIssues({ limit: 500 }));

    if (path === "/rpc/image")
      return Response.json(
        await app.extractImages({ markdown: "![](https://example.test/x.png)" }),
      );

    if (path === "/rpc/create")
      return Response.json(
        await app.saveIssue({ title: "From Widefleet", team: "ENG", labels: ["bug"] }),
      );

    if (path === "/rpc/delete")
      return Response.json(
        await app.deleteComment({ id: url.searchParams.get("id") ?? "comment-1" }),
      );

    return app.fetch(request);
  }
}
