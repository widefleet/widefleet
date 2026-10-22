import dns from "node:dns/promises";
import { classifyHost, isPublicRoutableHost } from "@better-auth/core/utils/host";
import { DiscoveryError, discoverOIDCConfig } from "@better-auth/sso";
import type { DiscoverOIDCConfigParams } from "@better-auth/sso";
import { z } from "zod";
import { identityUrl } from "@platform/contracts";

// Keep credentials, mappings and other native plugin fields when filling in
// endpoints on a migrated provider. Better Auth validates those fields itself.
export const oidcConfiguration = z.looseObject({
  authorizationEndpoint: z.url().optional(),
  tokenEndpoint: z.url().optional(),
  jwksEndpoint: z.url().optional(),
  userInfoEndpoint: z.url().optional(),
  discoveryEndpoint: z.url().optional(),
  tokenEndpointAuthentication: z
    .enum(["client_secret_basic", "client_secret_post", "private_key_jwt"])
    .optional(),
});

const absentRecord = (cause: unknown) => {
  const result = z.object({ code: z.enum(["ENODATA", "ENOTFOUND"]) }).safeParse(cause);

  if (!result.success) throw cause;

  return [];
};

const requirePublicOrigin = async (origin: string) => {
  const hostname = new URL(origin).hostname;

  if (isPublicRoutableHost(hostname)) {
    if (classifyHost(hostname).literal !== "fqdn") return;

    const records = await Promise.all([
      dns.resolve4(hostname).catch(absentRecord),
      dns.resolve6(hostname).catch(absentRecord),
    ]);

    const addresses = records.flat();

    if (addresses.length > 0 && addresses.every(isPublicRoutableHost)) return;
  }

  throw new DiscoveryError(
    "discovery_private_host",
    "Discovered SSO endpoints must resolve to public addresses",
    { url: origin },
  );
};

// The administrator-selected issuer is the trust anchor. Its authenticated
// discovery document can delegate to other HTTPS origins, but cannot expand
// that trust to private networks or Better Auth's wildcard origin patterns.
export const prepareCompanyOidc = async (
  issuer: string,
  configuration: z.infer<typeof oidcConfiguration>,
) => {
  const issuerOrigin = new URL(identityUrl.parse(issuer)).origin;

  if (issuerOrigin.includes("*"))
    throw new DiscoveryError("discovery_invalid_url", "SSO issuers cannot contain wildcards");
  const origins = new Set([issuerOrigin]);

  const discovered =
    !configuration.authorizationEndpoint ||
    !configuration.tokenEndpoint ||
    !configuration.jwksEndpoint;

  const accept = (value: string) => {
    const url = new URL(value);

    if (url.username || url.password || url.hash || url.hostname.includes("*")) return false;

    if (
      url.origin !== issuerOrigin &&
      (url.protocol !== "https:" || !isPublicRoutableHost(url.hostname))
    )
      return false;
    origins.add(url.origin);

    return true;
  };

  for (const endpoint of [
    configuration.authorizationEndpoint,
    configuration.tokenEndpoint,
    configuration.jwksEndpoint,
    configuration.userInfoEndpoint,
    discovered ? configuration.discoveryEndpoint : undefined,
  ]) {
    if (endpoint && !accept(endpoint))
      throw new DiscoveryError("discovery_untrusted_origin", "Unsafe SSO endpoint", {
        url: endpoint,
      });
  }

  // trustedOrigins bypasses Better Auth's DNS checks. Check saved endpoints too,
  // and validate any custom discovery host before fetching it.
  const checkHosts = () =>
    Promise.all(
      [...origins].flatMap((origin) =>
        origin === issuerOrigin ? [] : [requirePublicOrigin(origin)],
      ),
    );

  await checkHosts();

  if (discovered) {
    const parameters: DiscoverOIDCConfigParams = {
      issuer,
      isTrustedOrigin: accept,
    };

    if (configuration.discoveryEndpoint)
      parameters.discoveryEndpoint = configuration.discoveryEndpoint;
    const endpoints = await discoverOIDCConfig(parameters);

    configuration = {
      ...endpoints,
      ...Object.fromEntries(
        Object.entries(configuration).filter(([, value]) => value !== undefined),
      ),
    };
    await checkHosts();
  }

  return { configuration, origins: [...origins], discovered };
};
