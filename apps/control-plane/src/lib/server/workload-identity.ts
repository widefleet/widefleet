import { and, eq } from "drizzle-orm";
import { verifyWorkloadRequest, workloadLifetime } from "@platform/app-runtime/workload";
import type { createAuthentication } from "./auth.ts";
import type { DatabaseExecutor } from "./database.ts";
import type { OrganizationAccess } from "./application-context.ts";
import { apps, organizationRuntimes } from "./schema.ts";
import { installationOrganizationId } from "../organization.ts";
import { readBody } from "./upload-body.ts";

export const workloadIssuer = (platformUrl: string) => `${platformUrl}/api/workload`;

export const createWorkloadIdentity = (
  auth: ReturnType<typeof createAuthentication>,
  database: DatabaseExecutor,
  platformUrl: string,
  runtimeKey: (() => Promise<string | null>) | undefined,
  access: OrganizationAccess = { filterOrganizations: async () => [installationOrganizationId] },
) => ({
  async issue(request: Request) {
    const headers = { "cache-control": "no-store" };
    const secret = await runtimeKey?.();

    if (!secret) return new Response(null, { status: 503, headers });

    if (request.method !== "POST") return new Response(null, { status: 405, headers });
    // Bound the body before parsing even when Content-Length is absent or forged.
    const bytes = await readBody(request, 8192);

    if (bytes.isErr()) return new Response(null, { status: 413, headers });

    let identity;

    try {
      identity = await verifyWorkloadRequest(secret, new TextDecoder().decode(bytes.value));
    } catch {
      return new Response(null, { status: 401, headers });
    }

    const [app] = await database
      .select({ id: apps.id, blocked: organizationRuntimes.httpBlocked })
      .from(apps)
      .innerJoin(organizationRuntimes, eq(apps.organizationId, organizationRuntimes.organizationId))
      .where(
        and(
          eq(apps.id, identity.appId),
          eq(apps.organizationId, identity.organizationId),
          eq(apps.state, "active"),
        ),
      )
      .limit(1);

    if (
      !app ||
      app.blocked ||
      !(await access.filterOrganizations([{ id: identity.organizationId }])).includes(
        identity.organizationId,
      )
    )
      return new Response(null, { status: 403, headers });
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + workloadLifetime;

    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          iss: workloadIssuer(platformUrl),
          sub: `organization:${identity.organizationId}:app:${identity.appId}`,
          aud: identity.audience,
          iat: issuedAt,
          exp: expiresAt,
          jti: crypto.randomUUID(),
          workload_type: "app",
          organization_id: identity.organizationId,
          app_id: identity.appId,
        },
      },
    });

    return Response.json({ token, expiresAt }, { headers });
  },
});
