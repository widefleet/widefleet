import { WorkerEntrypoint } from "cloudflare:workers";
import { verifyAppCaller } from "./app-caller.ts";
import { requireOrganizationAvailability } from "./availability.ts";
import { readApp } from "./catalog.ts";
import { managedOAuth, type OAuthIdentity } from "./oauth.ts";
import type { OAuthRequest } from "./oauth-protocol.ts";
import type { ParentEnvironment } from "./types.ts";

export const oauthAppAvailable = async (
  environment: ParentEnvironment,
  identity: OAuthIdentity,
) => {
  const app = await readApp(environment, `hosts/${new URL(identity.origin).hostname}.json`);

  if (
    !app ||
    app.appId !== identity.appId ||
    app.organizationId !== identity.organizationId ||
    (app.origin ?? `https://${app.hostname}`) !== identity.origin
  )
    return false;
  await requireOrganizationAvailability(environment, identity.organizationId);

  return true;
};

export class AppOAuth extends WorkerEntrypoint<
  ParentEnvironment,
  {
    appId: string;
    organizationId: string;
    origin: string;
  }
> {
  async request(input: OAuthRequest, proof?: string) {
    if (!proof) throw new Error("Managed OAuth requires an authenticated app invocation");
    const { appId, organizationId, origin } = this.ctx.props;

    const { caller } = await verifyAppCaller(
      this.env.WIDEFLEET_CONTROL_TOKEN,
      appId,
      organizationId,
      proof,
    );

    const identity = { appId, organizationId, origin, caller };

    if (!(await oauthAppAvailable(this.env, identity)))
      throw new Error("OAuth app is not available");

    return managedOAuth(this.env).request(identity, input);
  }
}
