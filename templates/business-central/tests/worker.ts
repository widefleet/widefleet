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
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
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
      const value = env[z.enum(["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]).parse(name)];

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
  | "listEnvironments"
  | "listCompanies"
  | "listCustomers"
  | "createCustomer"
  | "updateCustomer"
  | "deleteCustomer"
  | "postSalesInvoice"
  | "sendSalesInvoice"
  | "downloadSalesInvoicePdf"
  | "approvalLevel"
  | "setApprovalLevel"
  | "fetch"
>;

const environment = "production";

const companyId = "8b4f0a20-0000-4000-8000-000000000001";

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
    const etag = url.searchParams.get("etag") ?? "";

    if (path === "/rpc/personal/status") return Response.json(await connection.status());

    if (path === "/rpc/personal/prepare")
      return Response.json(
        await connection.prepare(z.object({ completionUrl: z.url() }).parse(await request.json())),
      );

    if (path === "/rpc/personal/disconnect") return Response.json(await connection.disconnect());

    if (path === "/rpc/status") return Response.json(await app.connectionStatus());

    if (path === "/rpc/environments") return Response.json(await app.listEnvironments());

    if (path === "/rpc/list") return Response.json(await app.listCompanies({ environment }));

    if (path === "/rpc/customers")
      return Response.json(
        await app.listCustomers({
          environment,
          companyId,
          $filter: "balanceDue gt 0",
          $select: ["id", "number", "displayName"],
          $top: 50,
        }),
      );

    if (path === "/rpc/next")
      return Response.json(
        await app.listCustomers({ nextLink: url.searchParams.get("link") ?? "" }),
      );

    if (path === "/rpc/invalid")
      return Response.json(
        // @ts-expect-error Unknown arguments are rejected before anything is sent.
        await app.listCustomers({ environment, companyId, top: 5 }),
      );

    if (path === "/rpc/create")
      return Response.json(
        await app.createCustomer({ environment, companyId, body: { displayName: "Fabrikam" } }),
      );

    if (path === "/rpc/update")
      return Response.json(
        await app.updateCustomer({
          environment,
          companyId,
          customerId: "c-10000",
          etag,
          body: { displayName: "Adatum Corporation" },
        }),
      );

    if (path === "/rpc/update-without-etag")
      return Response.json(
        // @ts-expect-error A change needs the version it was read at.
        await app.updateCustomer({
          environment,
          companyId,
          customerId: "c-10000",
          body: { displayName: "Adatum Corporation" },
        }),
      );

    if (path === "/rpc/delete")
      return Response.json(
        await app.deleteCustomer({ environment, companyId, customerId: "c-10000", etag }),
      );

    if (path === "/rpc/post")
      return Response.json(
        await app.postSalesInvoice({ environment, companyId, salesInvoiceId: "i-1" }),
      );

    if (path === "/rpc/send")
      return Response.json(
        await app.sendSalesInvoice({ environment, companyId, salesInvoiceId: "i-1" }),
      );

    if (path === "/rpc/pdf")
      return Response.json(
        await app.downloadSalesInvoicePdf({ environment, companyId, salesInvoiceId: "i-1" }),
      );

    if (path === "/rpc/level") return Response.json(await app.approvalLevel());

    if (path === "/rpc/set-level")
      return Response.json(
        await app.setApprovalLevel({
          level: z
            .enum(["all_changes", "updates_and_deletions", "none"])
            .parse(url.searchParams.get("level")),
        }),
      );

    return app.fetch(request);
  }
}
