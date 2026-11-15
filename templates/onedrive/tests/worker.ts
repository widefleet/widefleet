import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import App from "../src/app.ts";
import type { OAuthBinding } from "../src/oauth.ts";
import type { Environment, Properties } from "../src/context.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

interface TestEnvironment extends Omit<Environment, "WIDEFLEET_SECRETS"> {
  TEST_OAUTH?: {
    request(
      caller: NonNullable<Properties["caller"]>,
      input: Parameters<OAuthBinding["request"]>[0],
    ): ReturnType<OAuthBinding["request"]>;
  };
  AUTH_SECRET: string;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
}

export class TestApp extends App {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, {
      ...env,
      WIDEFLEET_OAUTH: {
        request: async (input) => {
          if (!env.TEST_OAUTH) return null;

          if (!ctx.props.caller) throw new Error("Caller required");

          return env.TEST_OAUTH.request(ctx.props.caller, input);
        },
      },
      WIDEFLEET_SECRETS: {
        get: async (name) => {
          const value =
            env[
              z.enum(["AUTH_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"]).parse(name)
            ];

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

    if (path === "/rpc/list") return Response.json(await app.listFiles());

    if (path === "/rpc/content") return Response.json(await app.getDownloadUrl("file"));

    return app.fetch(request);
  }
}
