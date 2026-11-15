import { WorkerEntrypoint } from "cloudflare:workers";
import { requireOrganizationAvailability } from "./availability.ts";
import { readApp } from "./catalog.ts";
import {
  signWorkloadRequest,
  workloadAudience,
  workloadToken,
  workloadTokenPath,
} from "./workload-protocol.ts";
import type { ParentEnvironment } from "./types.ts";

export class WorkloadIdentity extends WorkerEntrypoint<
  ParentEnvironment,
  {
    appId: string;
    organizationId: string;
    hostname: string;
  }
> {
  async getToken(audience: string) {
    workloadAudience.parse(audience);
    const { appId, organizationId, hostname } = this.ctx.props;
    await requireOrganizationAvailability(this.env, organizationId);
    const app = await readApp(this.env, `hosts/${hostname}.json`);

    if (!app || app.appId !== appId || app.organizationId !== organizationId)
      throw new Error("Workload is not available");

    if (!this.env.WIDEFLEET_PLATFORM_URL) throw new Error("Workload identity is not configured");

    const proof = await signWorkloadRequest(
      this.env.WIDEFLEET_CONTROL_TOKEN,
      { appId, organizationId },
      audience,
    );

    const response = await fetch(new URL(workloadTokenPath, this.env.WIDEFLEET_PLATFORM_URL), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: proof,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) throw new Error(`Workload token issuance failed (${response.status})`);

    return workloadToken.parse(await response.json());
  }
}
