import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import App from "../src/app.ts";
import type { Environment, Properties } from "../src/context.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

interface TestEnvironment extends Omit<Environment, "WIDEFLEET_SECRETS"> {
  AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export class TestApp extends App {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, {
      ...env,
      WIDEFLEET_SECRETS: {
        get: async (name) => {
          const value =
            env[z.enum(["AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]).parse(name)];

          if (!value) throw new Error("App secret is not configured");

          return value;
        },
      },
    });
  }
}

// Widefleet supplies these props after verifying the signed-in caller.
export default class Host extends WorkerEntrypoint<TestEnvironment> {
  override async fetch(request: Request) {
    const subject = request.headers.get("test-subject");

    const app = this.ctx.exports.TestApp({
      props: {
        caller: subject
          ? {
              issuer: request.headers.get("test-issuer") ?? "https://identity.example.test",
              subject,
              name: subject,
            }
          : null,
      },
    });

    const path = new URL(request.url).pathname;

    if (path === "/rpc/status") return Response.json(await app.connectionStatus());

    if (path === "/rpc/list") return Response.json(await app.searchMessages());

    if (path === "/rpc/content") return Response.json(await app.getMessage("message"));

    return app.fetch(request);
  }
}
