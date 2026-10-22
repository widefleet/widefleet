import dns from "node:dns/promises";
import { classifyHost, isPublicRoutableHost } from "@better-auth/core/utils/host";
import {
  computeDiscoveryUrl,
  DiscoveryError,
  fetchDiscoveryDocument,
  normalizeDiscoveryUrls,
  validateDiscoveryDocument,
} from "@better-auth/sso";
import { z } from "zod";
import { identityUrl } from "@platform/contracts";

const cache = new Map<string, { expiresAt: number; origins: string[] }>();

const cacheDuration = 5 * 60 * 1000;

const cacheLimit = 100;

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
export const companyOidcOrigins = async (issuer: string) => {
  const issuerOrigin = new URL(identityUrl.parse(issuer)).origin;

  if (issuerOrigin.includes("*"))
    throw new DiscoveryError("discovery_invalid_url", "SSO issuers cannot contain wildcards");
  const cached = cache.get(issuer);
  let origins = cached && cached.expiresAt > Date.now() ? cached.origins : null;

  if (!origins) {
    const document = await fetchDiscoveryDocument(
      computeDiscoveryUrl(issuer),
      10_000,
      (url) => new URL(url).origin === issuerOrigin,
    );

    validateDiscoveryDocument(document, issuer);
    const discovered = new Set([issuerOrigin]);

    normalizeDiscoveryUrls(document, issuer, (value) => {
      const url = new URL(value);

      if (url.username || url.password || url.hash || url.hostname.includes("*")) return false;

      if (
        url.origin !== issuerOrigin &&
        (url.protocol !== "https:" || !isPublicRoutableHost(url.hostname))
      )
        return false;
      discovered.add(url.origin);

      return true;
    });
    origins = [...discovered];
  }

  // trustedOrigins bypasses Better Auth's DNS checks. Recheck delegated hosts
  // even on cache hits, rather than treating cached metadata as network policy.
  await Promise.all(origins.filter((origin) => origin !== issuerOrigin).map(requirePublicOrigin));

  if (origins !== cached?.origins) {
    if (cache.size >= cacheLimit) {
      const oldest = cache.keys().next().value;

      if (oldest !== undefined) cache.delete(oldest);
    }

    cache.set(issuer, { origins, expiresAt: Date.now() + cacheDuration });
  }

  return origins;
};
