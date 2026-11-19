import {
  mcpDomainKeys,
  mcpDomainPrefix,
  mcpOrganizationKey,
  mcpTenantPrefix,
} from "@platform/auth-proxy/mcp-login";
import type { AuthConfiguration } from "@platform/auth-proxy";
import { companyDomain, organizationIdentifier } from "@platform/contracts";
import { base64url } from "jose";
import { z } from "zod";
import { findMcpOrganization } from "./mcp-oauth.ts";
import type { ParentEnvironment } from "./types.ts";

const organizationsFrom = async (
  environment: ParentEnvironment,
  prefix: string,
  indexes: (configuration: AuthConfiguration) => string[],
) => {
  const organizations: AuthConfiguration[] = [];
  let cursor: string | undefined;

  do {
    const options: KVNamespaceListOptions = { prefix };

    if (cursor) options.cursor = cursor;
    const page = await environment.AUTH_CONFIG.list(options);

    for (const key of page.keys) {
      const organizationId = organizationIdentifier.safeParse(key.name.slice(prefix.length));

      const current = organizationId.success
        ? await findMcpOrganization(environment, organizationId.data)
        : null;

      // KV indexes can lag a changed company configuration. Authorize against the
      // current configuration, never against an index entry by itself.
      if (current && indexes(current).includes(key.name)) organizations.push(current);
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return organizations;
};

const tenantDiscovery = z.object({
  issuer: z
    .string()
    .regex(/^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/)
    .transform((issuer) => issuer.split("/")[3] ?? ""),
});

// Microsoft resolves every domain of a tenant, including ones not verified here.
const entraTenant = async (domain: string) => {
  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`,
      // Workers support only follow and manual; a redirect is not a discovery result.
      { redirect: "manual", signal: AbortSignal.timeout(5000) },
    );

    if (!response.ok) return null;
    const discovered = tenantDiscovery.safeParse(await response.json());

    return discovered.success ? discovered.data.issuer : null;
  } catch {
    return null;
  }
};

/**
 * Finds organizations whose company sign-in admits an email address, without the
 * control plane: verified company domains first, then the domain's Entra tenant.
 * Guests whose email belongs to another company are not found here.
 */
export const discoverOrganizations = async (environment: ParentEnvironment, email: string) => {
  const domain = companyDomain.safeParse(email.split("@").at(-1));

  if (!domain.success) return [];

  const byDomain = await organizationsFrom(
    environment,
    mcpDomainPrefix(domain.data),
    mcpDomainKeys,
  );

  if (byDomain.length) return byDomain;
  const tenant = await entraTenant(domain.data);

  return tenant
    ? organizationsFrom(environment, mcpTenantPrefix(tenant), (configuration) => {
        const key = mcpOrganizationKey(configuration);

        return key ? [key] : [];
      })
    : [];
};

const rememberedCookie = "__Host-widefleet-mcp-organizations";

const rememberedLimit = 5;

const rememberedValue = z.array(organizationIdentifier).max(rememberedLimit);

const signingKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`mcp-organizations:${z.string().min(32).parse(secret)}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const readRemembered = async (request: Request, secret: string) => {
  const value = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${rememberedCookie}=`))
    ?.slice(rememberedCookie.length + 1);

  const [payload, signature] = value?.split(".") ?? [];

  if (!payload || !signature) return [];

  try {
    const data = Uint8Array.from(base64url.decode(payload));

    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(secret),
        Uint8Array.from(base64url.decode(signature)),
        data,
      ))
    )
      return [];
    const parsed = rememberedValue.safeParse(JSON.parse(new TextDecoder().decode(data)));

    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
};

/** Organizations this browser connected before and that still offer company sign-in. */
export const rememberedOrganizations = async (request: Request, environment: ParentEnvironment) => {
  const organizations: AuthConfiguration[] = [];

  for (const organizationId of await readRemembered(request, environment.WIDEFLEET_CONTROL_TOKEN)) {
    const current = await findMcpOrganization(environment, organizationId).catch(() => null);

    if (current) organizations.push(current);
  }

  return organizations;
};

/** Remembers a connected organization in this browser, most recent first. */
export const rememberOrganization = async (
  request: Request,
  environment: ParentEnvironment,
  headers: Headers,
  organizationId: string,
) => {
  const organizations = [
    organizationId,
    ...(await readRemembered(request, environment.WIDEFLEET_CONTROL_TOKEN)).filter(
      (id) => id !== organizationId,
    ),
  ].slice(0, rememberedLimit);

  const data = new TextEncoder().encode(JSON.stringify(organizations));

  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await signingKey(environment.WIDEFLEET_CONTROL_TOKEN), data),
  );

  headers.append(
    "set-cookie",
    `${rememberedCookie}=${base64url.encode(data)}.${base64url.encode(signature)}; Path=/; Max-Age=15552000; Secure; HttpOnly; SameSite=Lax`,
  );
};

/** Whether the control plane answers, so a fallback to it can explain an outage first. */
export const controlPlaneAvailable = async (platformUrl: string) => {
  try {
    const response = await fetch(new URL("/healthz", platformUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });

    await response.body?.cancel();

    return response.ok;
  } catch {
    return false;
  }
};
