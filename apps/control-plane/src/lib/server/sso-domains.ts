import dns from "node:dns/promises";
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { maxCompanyDomains, parseCompanyDomains } from "@platform/contracts";
import { ssoProvider } from "./auth-schema.ts";
import type { DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { organizationSettings, ssoDomains } from "./schema.ts";

// Earlier releases verified through Better Auth; keeping its record name lets
// records published for those releases still prove the same domain.
const recordIdentifier = (providerId: string) => `_better-auth-token-${providerId}`;

const verificationToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const readProvider = async (database: DatabaseExecutor, organizationId: string) => {
  const [provider] = await database
    .select({
      providerId: ssoProvider.providerId,
      appIdentityType: ssoProvider.appIdentityType,
      domain: ssoProvider.domain,
      domainVerified: ssoProvider.domainVerified,
      required: organizationSettings.ssoRequired,
    })
    .from(ssoProvider)
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, ssoProvider.organizationId),
    )
    .where(eq(ssoProvider.organizationId, organizationId));

  return provider ?? null;
};

const readRows = (database: DatabaseExecutor, organizationId: string) =>
  database
    .select()
    .from(ssoDomains)
    .where(eq(ssoDomains.organizationId, organizationId))
    .orderBy(asc(ssoDomains.createdAt), asc(ssoDomains.domain));

// A provider verified through Better Auth itself lists its proven domains only in
// sso_provider. Count them as verified so tracking domains never revokes that proof.
const providerVerifiedDomains = (provider: { domain: string; domainVerified: boolean }) =>
  provider.domainVerified ? parseCompanyDomains(provider.domain) : [];

const adoptProviderDomains = async (transaction: DatabaseExecutor, organizationId: string) => {
  const provider = await readProvider(transaction, organizationId);
  const domains = provider ? providerVerifiedDomains(provider) : [];

  if (domains.length)
    await transaction
      .insert(ssoDomains)
      .values(
        domains.map((domain) => ({
          organizationId,
          domain,
          verificationToken: verificationToken(),
          verifiedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [ssoDomains.organizationId, ssoDomains.domain],
        set: { verifiedAt: sql`coalesce(${ssoDomains.verifiedAt}, now())` },
      });
};

export const readSsoDomains = async (database: DatabaseExecutor, organizationId: string) => {
  const provider = await readProvider(database, organizationId);

  if (!provider) return [];
  const adopted = new Set(providerVerifiedDomains(provider));
  const rows = await readRows(database, organizationId);
  const tracked = new Set(rows.map((row) => row.domain));

  return [
    ...[...adopted].flatMap((domain) =>
      tracked.has(domain) ? [] : [{ domain, verified: true, verificationToken: "" }],
    ),
    ...rows.map((row) => ({
      domain: row.domain,
      verified: row.verifiedAt !== null || adopted.has(row.domain),
      verificationToken: row.verificationToken,
    })),
  ].map((row) => ({
    domain: row.domain,
    verified: row.verified,
    record: row.verified
      ? null
      : {
          name: `${recordIdentifier(provider.providerId)}.${row.domain}`,
          type: "TXT" as const,
          value: row.verificationToken,
        },
  }));
};

// Better Auth decides SSO trust from the provider's single domain value. It lists
// only verified domains, or the pending ones before any domain is verified.
const mirrorToProvider = async (transaction: DatabaseExecutor, organizationId: string) => {
  const rows = await readRows(transaction, organizationId);
  const verified = rows.filter((row) => row.verifiedAt !== null).map((row) => row.domain);

  await transaction
    .update(ssoProvider)
    .set({
      domain: (verified.length ? verified : rows.map((row) => row.domain)).join(","),
      domainVerified: verified.length > 0,
    })
    .where(eq(ssoProvider.organizationId, organizationId));
};

export const changeSsoDomains = async (
  transaction: DatabaseExecutor,
  organizationId: string,
  change: { add?: string[]; remove?: string[] } | { replace: string[] },
) => {
  const provider = await readProvider(transaction, organizationId);

  if (!provider)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Save the company SSO configuration first",
    });

  await adoptProviderDomains(transaction, organizationId);
  const rows = await readRows(transaction, organizationId);
  const existing = new Set(rows.map((row) => row.domain));
  const add = "replace" in change ? change.replace : (change.add ?? []);

  const remove =
    "replace" in change
      ? [...existing].filter((domain) => !change.replace.includes(domain))
      : (change.remove ?? []);

  const added = [...new Set(add)].filter((domain) => !existing.has(domain));
  const removed = new Set(remove.filter((domain) => existing.has(domain)));
  const remaining = rows.filter((row) => !removed.has(row.domain));
  const count = remaining.length + added.length;

  if (count === 0)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Keep at least one company email domain",
    });

  if (count > maxCompanyDomains)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: `Company SSO supports at most ${maxCompanyDomains} email domains`,
    });

  if (provider.appIdentityType === "google" && count > 1)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Google Workspace app identity supports one company email domain",
    });

  if (
    provider.required &&
    rows.some((row) => row.verifiedAt !== null) &&
    !remaining.some((row) => row.verifiedAt !== null)
  )
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "Keep a verified email domain while company SSO is required",
    });

  if (removed.size)
    await transaction
      .delete(ssoDomains)
      .where(
        and(
          eq(ssoDomains.organizationId, organizationId),
          inArray(ssoDomains.domain, [...removed]),
        ),
      );

  if (added.length)
    await transaction.insert(ssoDomains).values(
      added.map((domain) => ({
        organizationId,
        domain,
        verificationToken: verificationToken(),
      })),
    );

  await mirrorToProvider(transaction, organizationId);
};

const publishedTokens = async (name: string) => {
  try {
    return (await dns.resolveTxt(name)).map((record) => record.join("").trim());
  } catch {
    // A missing or not yet propagated record is reported as unverified below.
    return [];
  }
};

export const verifySsoDomains = async (
  database: DatabaseExecutor,
  organizationId: string,
  domain?: string,
) => {
  const provider = await readProvider(database, organizationId);

  if (!provider)
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "Save the company SSO configuration first",
    });

  const domains = await readSsoDomains(database, organizationId);
  const selected = domain ? domains.filter((entry) => entry.domain === domain) : domains;

  if (domain && selected.length === 0)
    throw new InvalidOperation({
      code: "NOT_FOUND",
      message: `${domain} is not a company email domain`,
    });

  const pending = selected.flatMap((entry) =>
    entry.record ? [{ domain: entry.domain, ...entry.record }] : [],
  );

  if (pending.length === 0)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: domain ? `${domain} is already verified` : "Every company email domain is verified",
    });

  const identifier = recordIdentifier(provider.providerId);

  const found = (
    await Promise.all(
      pending.map(async (record) => {
        const tokens = await publishedTokens(record.name);

        return tokens.includes(record.value) || tokens.includes(`${identifier}=${record.value}`)
          ? record.domain
          : null;
      }),
    )
  ).filter((entry) => entry !== null);

  if (found.length) {
    const [claimed] = await database
      .select({ domain: ssoDomains.domain })
      .from(ssoDomains)
      .where(
        and(
          inArray(ssoDomains.domain, found),
          isNotNull(ssoDomains.verifiedAt),
          ne(ssoDomains.organizationId, organizationId),
        ),
      );

    if (claimed)
      throw new InvalidOperation({
        code: "CONFLICT",
        message: `${claimed.domain} is verified by another organization`,
      });

    await database.transaction(async (transaction) => {
      await adoptProviderDomains(transaction, organizationId);
      await transaction
        .update(ssoDomains)
        .set({ verifiedAt: new Date() })
        .where(
          and(
            eq(ssoDomains.organizationId, organizationId),
            inArray(ssoDomains.domain, found),
            isNull(ssoDomains.verifiedAt),
          ),
        );
      await mirrorToProvider(transaction, organizationId);
    });
  }

  return {
    verified: found,
    missing: pending.map((record) => record.domain).filter((entry) => !found.includes(entry)),
  };
};
