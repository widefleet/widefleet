import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import GmailApp from "../src/app.ts";
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
  GOOGLE_CLIENT_SECRET: string;
}

export class Gmail extends GmailApp {
  constructor(ctx: ExecutionContext<Properties>, env: TestEnvironment) {
    super(ctx, {
      ...env,
      WIDEFLEET_SECRETS: {
        get: (name) =>
          Promise.resolve(env[z.enum(["AUTH_SECRET", "GOOGLE_CLIENT_SECRET"]).parse(name)]),
      },
    });
  }
}

// Test-only host. Widefleet supplies these props after SSO and caller verification;
// this fixture exercises the app boundary without a real company IdP.
export default class Host extends WorkerEntrypoint<TestEnvironment> {
  override async fetch(request: Request) {
    const subject = request.headers.get("test-subject");

    const gmail = this.ctx.exports.Gmail({
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

    const url = new URL(request.url);

    if (url.pathname === "/rpc/status") return Response.json(await gmail.connectionStatus());

    if (url.pathname === "/rpc/messages")
      return Response.json(await gmail.listMessages({ maxResults: 5, pageToken: "next-page" }));

    if (url.pathname === "/rpc/message") return Response.json(await gmail.getMessage("abc123"));

    return gmail.fetch(request);
  }
}
