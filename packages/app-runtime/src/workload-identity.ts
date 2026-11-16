import { WorkerEntrypoint } from "cloudflare:workers";
import { requireOrganizationAvailability } from "./availability.ts";
import { readApp } from "./catalog.ts";
import { signWorkloadToken, workloadKeys } from "./workload-keys.ts";
import {
  workloadAudience,
  workloadConfiguration,
  workloadConfigurationKey,
} from "./workload-protocol.ts";
import type { ParentEnvironment } from "./types.ts";

const configuration = async (environment: ParentEnvironment) => {
  const object = await environment.WIDEFLEET_PACKAGES.get(workloadConfigurationKey);

  if (!object) return null;

  return workloadConfiguration.parse(await object.json());
};

export const publishWorkloadConfiguration = async (
  request: Request,
  environment: ParentEnvironment,
) => {
  if (request.method !== "PUT") return new Response(null, { status: 405 });
  const value = workloadConfiguration.parse(await request.json());
  const serialized = JSON.stringify(value);
  const current = await environment.WIDEFLEET_PACKAGES.get(workloadConfigurationKey);

  if (!current || (await current.text()) !== serialized)
    await environment.WIDEFLEET_PACKAGES.put(workloadConfigurationKey, serialized);

  return new Response(null, { status: 204 });
};

// This public metadata is served by the parent runtime, on the existing SSO host.
// It needs neither the control-plane process nor its database, including on cold starts.
export const workloadDiscovery = async (request: Request, environment: ParentEnvironment) => {
  const url = new URL(request.url);

  if (!["/workload/jwks", "/workload/.well-known/openid-configuration"].includes(url.pathname))
    return null;
  const value = await configuration(environment);

  if (!value || url.origin !== new URL(value.issuer).origin) return null;

  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });

  const document = url.pathname.endsWith("/jwks")
    ? (await workloadKeys(environment)).jwks
    : {
        issuer: value.issuer,
        jwks_uri: `${value.issuer}/jwks`,
        id_token_signing_alg_values_supported: ["EdDSA"],
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
    const { appId, organizationId, hostname } = this.ctx.props;
    await requireOrganizationAvailability(this.env, organizationId);

    const [app, published] = await Promise.all([
      readApp(this.env, `hosts/${hostname}.json`),
      configuration(this.env),
    ]);

    if (
      !published ||
      !app ||
      app.appId !== appId ||
      app.organizationId !== organizationId ||
      !published.organizations.includes(organizationId)
    )
      throw new Error("Workload is not available");

    return signWorkloadToken(this.env, published.issuer, { appId, organizationId }, audience);
  }
}
