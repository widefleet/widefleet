import { and, asc, count, eq, inArray, ne, notExists, sql } from "drizzle-orm";
import { installationSettings, joinDomains, parseCompanyDomains } from "@platform/contracts";
import type { z } from "zod";
import type { joinableOrganization } from "@platform/contracts";
import type { OrganizationAccess } from "./application-context.ts";
import { account, member, organization, ssoProvider, user } from "./auth-schema.ts";
import type { Authentication } from "./auth.ts";
import type { DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { organizationOperation } from "./organization-operations.ts";
import { organizationRuntimes, organizationSettings } from "./schema.ts";
import { providerEmailDomain } from "./social-sign-in.ts";
import { companySignInLimit, type SignIn } from "./sso-policy.ts";

const emailDomain = (email: string) => email.toLowerCase().split("@")[1] ?? "";

const readPerson = async (database: DatabaseExecutor, userId: string) => {
  const [person] = await database
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));

  return person ?? null;
};

// A company domain proven by the person's own sign-ins: the domain of their verified address,
// when a linked Google Workspace or Microsoft work account confirms that a company owns it.
// An email code proves only the mailbox, so a mail provider's domain never qualifies.
export const provenEmailDomain = async (database: DatabaseExecutor, userId: string) => {
  const person = await readPerson(database, userId);

  if (!person?.emailVerified) return null;
  const domain = emailDomain(person.email);

  const accounts = await database
    .select({ providerId: account.providerId, idToken: account.idToken })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        inArray(account.providerId, ["widefleet-google", "widefleet-microsoft"]),
      ),
    );

  return accounts.some((entry) => providerEmailDomain(entry.providerId, entry.idToken) === domain)
    ? domain
    : null;
};

// Organizations that verified the domain by DNS and keep new organizations on it to their
// administrators.
const restrictingOrganizations = async (database: DatabaseExecutor, domain: string) =>
  (
    await database
      .select({ organizationId: ssoProvider.organizationId })
      .from(ssoProvider)
      .innerJoin(
        organizationSettings,
        eq(organizationSettings.organizationId, ssoProvider.organizationId),
      )
      .where(
        and(
          eq(ssoProvider.domainVerified, true),
          // sso_provider lists only verified domains once any domain is verified.
          sql`${domain} = any(string_to_array(${ssoProvider.domain}, ','))`,
          eq(organizationSettings.restrictOrganizationCreation, true),
        ),
      )
  ).map((entry) => entry.organizationId);

const restrictionMessage = (domain: string) =>
  `Your company manages Widefleet organizations for ${domain}. Ask one of its administrators for access.`;

// The restricted domain when the person's company reserves new organizations for its
// administrators, or null when the person can create one.
export const organizationCreationRestriction = async (
  database: DatabaseExecutor,
  userId: string,
) => {
  const person = await readPerson(database, userId);

  if (!person) return null;
  const domain = emailDomain(person.email);
  const restricting = await restrictingOrganizations(database, domain);

  if (!restricting.length) return null;

  const [administrator] = await database
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        inArray(member.organizationId, restricting),
        inArray(member.role, ["owner", "admin"]),
      ),
    )
    .limit(1);

  return administrator ? null : domain;
};

// The domain the person may open an organization to: proven by their own sign-in and not
// reserved by another organization that verified it.
export const offeredJoinDomain = async (
  database: DatabaseExecutor,
  userId: string,
  organizationId: string | null,
) => {
  const domain = await provenEmailDomain(database, userId);

  if (!domain) return null;

  const restricting = (await restrictingOrganizations(database, domain)).filter(
    (id) => id !== organizationId,
  );

  return restricting.length ? null : domain;
};

export const requireJoinDomain = async (
  database: DatabaseExecutor,
  userId: string,
  organizationId: string | null,
  domain: string,
) => {
  if ((await provenEmailDomain(database, userId)) !== domain)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: `Sign in with a Google Workspace or Microsoft work account on ${domain} to let its addresses join.`,
    });

  if ((await offeredJoinDomain(database, userId, organizationId)) !== domain)
    throw new InvalidOperation({ code: "FORBIDDEN", message: restrictionMessage(domain) });
};

export const requireOrganizationCreation = async (database: DatabaseExecutor, userId: string) => {
  const restricted = await organizationCreationRestriction(database, userId);

  if (restricted)
    throw new InvalidOperation({ code: "FORBIDDEN", message: restrictionMessage(restricted) });
};

const lockSettings = async (transaction: DatabaseExecutor, organizationId: string) => {
  await transaction
    .insert(organizationSettings)
    .values({ organizationId, settings: installationSettings.parse({}) })
    .onConflictDoNothing();

  const [current] = await transaction
    .select({
      joinDomains: organizationSettings.joinDomains,
      restrictOrganizationCreation: organizationSettings.restrictOrganizationCreation,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .for("update");

  return {
    joinDomains: joinDomains.parse(current?.joinDomains ?? []),
    restrictOrganizationCreation: current?.restrictOrganizationCreation === true,
  };
};

// Callers check the domain with requireJoinDomain first.
export const addJoinDomain = (database: DatabaseExecutor, organizationId: string, domain: string) =>
  database.transaction(async (transaction) => {
    const current = await lockSettings(transaction, organizationId);

    if (current.joinDomains.includes(domain)) return;
    const next = joinDomains.safeParse([...current.joinDomains, domain]);

    if (!next.success)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: next.error.issues[0]?.message ?? "Too many domains",
      });

    await transaction
      .update(organizationSettings)
      .set({ joinDomains: next.data })
      .where(eq(organizationSettings.organizationId, organizationId));
  });

const verifiedDomains = async (database: DatabaseExecutor, organizationId: string) => {
  const [provider] = await database
    .select({ domain: ssoProvider.domain, domainVerified: ssoProvider.domainVerified })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, organizationId));

  return provider?.domainVerified ? parseCompanyDomains(provider.domain) : [];
};

const requireAdmin = (principal: Principal) => {
  if (!principal.application.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Only organization owners and admins can manage domain access.",
    });
};

// Organizations a person can join because their verified address is on one of the
// organization's join domains. A company sign-in limited to its organization joins nothing else.
const joinableOrganizations = async (
  database: DatabaseExecutor,
  access: OrganizationAccess,
  signIn: SignIn,
): Promise<z.infer<typeof joinableOrganization>[]> => {
  const person = await readPerson(database, signIn.userId);

  if (!person?.emailVerified) return [];
  const domain = emailDomain(person.email);
  const limit = await companySignInLimit(database, signIn);

  const candidates = await database
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      providerDomain: ssoProvider.domain,
      domainVerified: ssoProvider.domainVerified,
    })
    .from(organizationSettings)
    .innerJoin(organization, eq(organization.id, organizationSettings.organizationId))
    .innerJoin(organizationRuntimes, eq(organizationRuntimes.organizationId, organization.id))
    .leftJoin(ssoProvider, eq(ssoProvider.organizationId, organization.id))
    .where(
      and(
        sql`${organizationSettings.joinDomains} @> ${JSON.stringify([domain])}::jsonb`,
        notExists(
          database
            .select({ id: member.id })
            .from(member)
            .where(
              and(eq(member.organizationId, organization.id), eq(member.userId, signIn.userId)),
            ),
        ),
      ),
    )
    .orderBy(asc(organization.name), asc(organization.id));

  const admitted = new Set(await access.filterOrganizations(candidates));

  const available = candidates.filter(
    (candidate) => admitted.has(candidate.id) && (limit === null || limit === candidate.id),
  );

  if (!available.length) return [];
  const ids = available.map((candidate) => candidate.id);

  const counts = new Map(
    (
      await database
        .select({ organizationId: member.organizationId, members: count() })
        .from(member)
        .where(inArray(member.organizationId, ids))
        .groupBy(member.organizationId)
    ).map((entry) => [entry.organizationId, entry.members]),
  );

  // Only colleagues on the same domain are shown, never external guests.
  const colleagues = await database
    .select({ organizationId: member.organizationId, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        inArray(member.organizationId, ids),
        ne(member.userId, signIn.userId),
        eq(user.emailVerified, true),
        sql`split_part(lower(${user.email}), '@', 2) = ${domain}`,
      ),
    )
    .orderBy(asc(member.createdAt), asc(member.id));

  return available.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    slug: candidate.slug,
    domain,
    memberCount: counts.get(candidate.id) ?? 0,
    colleagues: colleagues
      .filter((entry) => entry.organizationId === candidate.id)
      .slice(0, 3)
      .map((entry) => entry.name),
    verified:
      candidate.domainVerified === true &&
      parseCompanyDomains(candidate.providerDomain ?? "").includes(domain),
  }));
};

export const createDomainAccess = (
  database: DatabaseExecutor,
  auth: Authentication,
  access: OrganizationAccess,
  // Joining by domain belongs to installations where people create their own organizations.
  enabled: boolean,
) => {
  const requireEnabled = () => {
    if (!enabled)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "Joining by email domain is unavailable on this installation",
      });
  };

  const view = async (principal: Principal) => {
    const organizationId = principal.application.organizationId;

    const [settings] = await database
      .select({
        joinDomains: organizationSettings.joinDomains,
        restrictOrganizationCreation: organizationSettings.restrictOrganizationCreation,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId));

    const offered = await offeredJoinDomain(database, principal.id, organizationId);

    return {
      joinDomains: joinDomains.parse(settings?.joinDomains ?? []),
      provableDomains: offered ? [offered] : [],
      verifiedDomains: await verifiedDomains(database, organizationId),
      restrictOrganizationCreation: settings?.restrictOrganizationCreation === true,
    };
  };

  return {
    enabled,
    joinable: async (signIn: SignIn) => {
      requireEnabled();

      return joinableOrganizations(database, access, signIn);
    },
    join: async (signIn: SignIn, organizationId: string) => {
      requireEnabled();

      const target = (await joinableOrganizations(database, access, signIn)).find(
        (candidate) => candidate.id === organizationId,
      );

      if (!target)
        throw new InvalidOperation({
          code: "NOT_FOUND",
          message: "This organization is not open to your email domain",
        });

      // Better Auth enforces the organization's member limit.
      await organizationOperation({ auth, headers: new Headers() }, (api) =>
        api.addMember({ body: { userId: signIn.userId, organizationId, role: "member" } }),
      );

      return { organizationId: target.id, slug: target.slug };
    },
    read: async (principal: Principal) => {
      requireEnabled();
      requireAdmin(principal);

      return view(principal);
    },
    addJoinDomain: async (principal: Principal, domain: string) => {
      requireEnabled();
      requireAdmin(principal);
      await requireJoinDomain(database, principal.id, principal.application.organizationId, domain);
      await addJoinDomain(database, principal.application.organizationId, domain);

      return view(principal);
    },
    // Members who joined through the domain keep their membership.
    removeJoinDomain: async (principal: Principal, domain: string) => {
      requireEnabled();
      requireAdmin(principal);
      const organizationId = principal.application.organizationId;

      await database.transaction(async (transaction) => {
        const current = await lockSettings(transaction, organizationId);

        if (!current.joinDomains.includes(domain))
          throw new InvalidOperation({
            code: "NOT_FOUND",
            message: `${domain} is not a join domain`,
          });

        await transaction
          .update(organizationSettings)
          .set({ joinDomains: current.joinDomains.filter((entry) => entry !== domain) })
          .where(eq(organizationSettings.organizationId, organizationId));
      });

      return view(principal);
    },
    restrictOrganizationCreation: async (principal: Principal, restricted: boolean) => {
      requireEnabled();
      requireAdmin(principal);
      const organizationId = principal.application.organizationId;

      await database.transaction(async (transaction) => {
        await lockSettings(transaction, organizationId);

        if (restricted && !(await verifiedDomains(transaction, organizationId)).length)
          throw new InvalidOperation({
            code: "CONFLICT",
            message: "Verify a company domain for company SSO before restricting new organizations",
          });

        await transaction
          .update(organizationSettings)
          .set({ restrictOrganizationCreation: restricted })
          .where(eq(organizationSettings.organizationId, organizationId));
      });

      return view(principal);
    },
  };
};

export type DomainAccess = ReturnType<typeof createDomainAccess>;
