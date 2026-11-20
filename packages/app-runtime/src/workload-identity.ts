import { WorkerEntrypoint } from "cloudflare:workers";
import { requireOrganizationAvailability } from "./availability.ts";
import { readApp } from "./catalog.ts";
import { signWorkloadToken, workloadKeys } from "./workload-keys.ts";
import { workloadAudience, workloadIssuer } from "./workload-protocol.ts";
import type { ParentEnvironment } from "./types.ts";

// This public metadata is served by the parent runtime, on the existing SSO host.
// It needs neither the control-plane process nor its database, including on cold starts.
export const workloadDiscovery = async (request: Request, environment: ParentEnvironment) => {
  const url = new URL(request.url);

  if (!["/workload/jwks", "/workload/.well-known/openid-configuration"].includes(url.pathname))
    return null;

  if (!environment.WIDEFLEET_WORKLOAD_ISSUER) return null;
  const issuer = workloadIssuer.parse(environment.WIDEFLEET_WORKLOAD_ISSUER);

  if (url.origin !== new URL(issuer).origin) return null;

  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });

  const document = url.pathname.endsWith("/jwks")
    ? (await workloadKeys(environment)).jwks
    : {
        issuer,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        subject_types_supported: ["public"],
        response_types_supported: [],
      };

  return new Response(request.method === "HEAD" ? null : JSON.stringify(document), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
  });
};

export class WorkloadIdentity extends WorkerEntrypoint<
  ParentEnvironment,
  { appId: string; organizationId: string; hostname: string }
> {
  async getToken(audience: string) {
    workloadAudience.parse(audience);
    const issuer = workloadIssuer.parse(this.env.WIDEFLEET_WORKLOAD_ISSUER);
    const { appId, organizationId, hostname } = this.ctx.props;
    await requireOrganizationAvailability(this.env, organizationId);

    const app = await readApp(this.env, `hosts/${hostname}.json`, { appId, organizationId });

    if (!app || app.appId !== appId || app.organizationId !== organizationId)
      throw new Error("Workload is not available");

    return signWorkloadToken(this.env, issuer, { appId, organizationId }, audience);
  }
}
