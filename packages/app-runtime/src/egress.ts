import { WorkerEntrypoint } from "cloudflare:workers";
import { forward } from "./network.ts";
import { isAccessTokenPlaceholder, openAccessToken } from "./oauth.ts";
import type { ParentEnvironment } from "./types.ts";

export class Gateway extends WorkerEntrypoint<
  ParentEnvironment,
  { origins: string[]; appId: string }
> {
  override async fetch(request: Request) {
    const authorization = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

    // Managed OAuth access tokens reach apps as placeholders. The real token is
    // set only for this app's requests to its client's hosts.
    if (authorization && isAccessTokenPlaceholder(authorization)) {
      const token = await openAccessToken(
        this.env,
        this.ctx.props.appId,
        authorization,
        new URL(request.url),
      );

      if (!token)
        return new Response("The access token is not permitted for this destination", {
          status: 403,
        });
      const headers = new Headers(request.headers);
      headers.set("authorization", `Bearer ${token}`);

      return forward(new Request(request, { headers }), this.ctx.props.origins);
    }

    return forward(request, this.ctx.props.origins);
  }
}
