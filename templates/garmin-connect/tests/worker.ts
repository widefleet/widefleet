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

type TestEnvironment = Omit<Environment, "WIDEFLEET_KEYS">;

const encoder = new TextEncoder();

// Stands in for the runtime's key binding with a fixed synthetic key.
const testKey = () =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode("synthetic-key-of-thirty-two-byte"),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

const keys: Environment["WIDEFLEET_KEYS"] = {
  encrypt: async (name, data) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      await testKey(),
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
        await testKey(),
        bytes.slice(12),
      ),
    );
  },
};

const testEnvironment = (env: TestEnvironment): Environment => ({ ...env, WIDEFLEET_KEYS: keys });

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
  | "searchActivities"
  | "getDailySleep"
  | "getHrv"
  | "downloadActivity"
  | "listDailySteps"
  | "fetch"
>;

// Widefleet supplies these props after verifying the signed-in caller.
export default class Host extends WorkerEntrypoint<TestEnvironment> {
  override async fetch(request: Request) {
    const subject = request.headers.get("test-subject");

    const caller = subject
      ? {
          issuer: request.headers.get("test-issuer") ?? "https://identity.example.test",
          subject,
          name: subject,
        }
      : null;

    const stub: unknown = this.ctx.exports.TestApp({ props: { caller } });

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

    if (path === "/rpc/activities")
      return Response.json(await app.searchActivities({ limit: 5, activityType: "running" }));

    if (path === "/rpc/sleep")
      return Response.json(await app.getDailySleep({ date: "2026-11-20" }));

    if (path === "/rpc/hrv") return Response.json(await app.getHrv({ calendarDate: "2026-11-20" }));

    if (path === "/rpc/download")
      return Response.json(await app.downloadActivity({ activityId: 1001 }));

    if (path === "/rpc/steps")
      return Response.json(
        await app.listDailySteps({ startDate: "2026-10-01", endDate: "2026-11-20" }),
      );

    if (path === "/rpc/invalid")
      return Response.json(
        // @ts-expect-error Unknown arguments are rejected before anything is sent.
        await app.getHrv({ calendarDate: "2026-11-20", day: "2026-11-20" }),
      );

    return app.fetch(request);
  }
}
