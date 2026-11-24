import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import App, { UserConnection } from "../src/app.ts";
import type { Environment, Properties } from "../src/context.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

interface TestEnvironment extends Omit<Environment, "WIDEFLEET_SECRETS" | "WIDEFLEET_KEYS"> {
  QONTO_CLIENT_ID: string;
  QONTO_CLIENT_SECRET: string;
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

const testEnvironment = (env: TestEnvironment): Environment => ({
  ...env,
  WIDEFLEET_KEYS: keys,
  WIDEFLEET_SECRETS: {
    get: async (name) => {
      const value = env[z.enum(["QONTO_CLIENT_ID", "QONTO_CLIENT_SECRET"]).parse(name)];

      if (!value) throw new Error("App secret is not configured");

      return value;
    },
  },
});

export class TestApp extends App {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, testEnvironment(env));
  }
}

export class TestUserConnection extends UserConnection {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, testEnvironment(env));
  }
}

// The methods these tests call, as a consuming app declares them. Cloudflare's
// RPC types for the loopback binding fail on recursive JSON results (TS2589,
// cloudflare/workerd#3063).
type Binding = Pick<
  TestApp,
  | "connectionStatus"
  | "getMembership"
  | "listTransactions"
  | "listClients"
  | "downloadIbanCertificate"
  | "createSepaTransfer"
  | "uploadAttachment"
  | "createSupplierInvoice"
  | "revokeAccess"
  | "approvalLevel"
  | "setApprovalLevel"
  | "fetch"
>;

// An answer as Widefleet passes it back, with the state its question returned.
const scaInput = z.object({
  inputResponses: z.record(
    z.string(),
    z.object({ action: z.enum(["accept", "decline", "cancel"]) }),
  ),
  requestState: z.object({
    idempotencyKey: z.string(),
    scaSessionToken: z.string().optional(),
  }),
});

// The user's answer: Widefleet's own approval as its action alone, or an answer with its state as JSON.
const answer = (text: string) => {
  const approval = z.enum(["accept", "decline"]).safeParse(text);

  return approval.success
    ? { inputResponses: { approve: { action: approval.data } } }
    : scaInput.parse(JSON.parse(text));
};

// Widefleet supplies these props after verifying the signed-in caller, and the
// user's answer when it calls a method again after a question.
export default class Host extends WorkerEntrypoint<TestEnvironment> {
  override async fetch(request: Request) {
    const subject = request.headers.get("test-subject");
    const answered = request.headers.get("test-answer");

    const caller = subject
      ? {
          issuer: request.headers.get("test-issuer") ?? "https://identity.example.test",
          subject,
          name: subject,
        }
      : null;

    const input = answered ? answer(answered) : undefined;

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

    if (path === "/rpc/membership") return Response.json(await app.getMembership());

    if (path === "/rpc/transactions")
      return Response.json(
        await app.listTransactions({ iban: "FR7616798000010000004321396", per_page: 1 }),
      );

    if (path === "/rpc/clients")
      return Response.json(await app.listClients({ "filter[name]": "Acme", per_page: 10 }));

    if (path === "/rpc/invalid")
      return Response.json(
        // @ts-expect-error Unknown arguments are rejected before anything is sent.
        await app.listTransactions({ bankAccount: "x" }),
      );

    if (path === "/rpc/certificate")
      return Response.json(await app.downloadIbanCertificate({ id: "account-1" }));

    if (path === "/rpc/upload")
      return Response.json(
        await app.uploadAttachment({
          body: { file: { mimeType: "application/pdf", base64: btoa("%PDF-1.7 receipt") } },
        }),
      );

    if (path === "/rpc/supplier-invoice")
      return Response.json(
        await app.createSupplierInvoice({
          body: {
            "supplier_invoices[][file]": { mimeType: "application/pdf", text: "%PDF-1.7 invoice" },
            "supplier_invoices[][idempotency_key]": "invoice-key",
          },
        }),
      );

    if (path === "/rpc/transfer")
      return Response.json(
        await app.createSepaTransfer({
          body: {
            vop_proof_token: "proof",
            transfer: {
              beneficiary_id: url.searchParams.get("beneficiary") ?? "new-beneficiary",
              bank_account_id: "account-1",
              reference: "Invoice 42",
              amount: "120.00",
            },
          },
        }),
      );

    if (path === "/rpc/revoke") return Response.json(await app.revokeAccess());

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
