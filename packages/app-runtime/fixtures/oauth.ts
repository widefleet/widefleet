import { WorkerEntrypoint } from "cloudflare:workers";
import { appCaller } from "@platform/contracts";
import { z } from "zod";
import { signAppCaller } from "../src/app-caller.ts";
import { oauthAppAvailable } from "../src/app-oauth.ts";
import { managedOAuth } from "../src/oauth.ts";
import { oauthRequest, type OAuthRequest } from "../src/oauth-protocol.ts";
import type { ParentEnvironment } from "../src/types.ts";

export { AppOAuth } from "../src/app-oauth.ts";

const appId = "00000000-0000-4000-8000-000000000001";

const organizationId = "test-org";

// The test host supplies the same identity that production verifies before entering an app.
export class TestOAuth extends WorkerEntrypoint<ParentEnvironment> {
  async request(caller: z.infer<typeof appCaller>, input: OAuthRequest) {
    const proof = await signAppCaller(
      this.env.WIDEFLEET_CONTROL_TOKEN,
      appId,
      organizationId,
      caller,
    );

    return this.ctx.exports
      .AppOAuth({
        props: {
          appId,
          organizationId,
          origin: z.string().parse(this.env["TEST_ORIGIN"]),
        },
      })
      .request(input, proof);
  }
}

export default class Host extends WorkerEntrypoint<ParentEnvironment> {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/binding") {
      try {
        const result = await this.ctx.exports
          .AppOAuth({
            props: {
              appId,
              organizationId,
              origin: z.string().parse(this.env["TEST_ORIGIN"]),
            },
          })
          .request(
            oauthRequest.parse(await request.json()),
            request.headers.get("test-proof") ?? undefined,
          );

        return Response.json(result);
      } catch {
        return new Response(null, { status: 403 });
      }
    }

    return (
      (await managedOAuth(this.env).callback(request, (identity) =>
        oauthAppAvailable(this.env, identity),
      )) ?? new Response(null, { status: 404 })
    );
  }
}
