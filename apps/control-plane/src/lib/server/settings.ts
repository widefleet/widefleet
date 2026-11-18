import {
  installationSettings,
  parseCompanyDomains,
  settingsInput,
  settingsUpdate,
  setupOwner,
} from "@platform/contracts";
import { eq, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { OrganizationCredential } from "./organization-operations.ts";
import { appCallbackUrl, type AppSignIn } from "./app-sign-in.ts";
import { companyIdentity } from "./company-identity.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";
import { decryptSecret, encryptSecret } from "./secret-encryption.ts";
import { installationOrganizationId } from "../organization.ts";
import { readOrganizationSettings, createInstallationOwner } from "./installation-store.ts";
import { oauthClient, organization } from "./auth-schema.ts";
import {
  readSsoConfiguration,
  readSsoProvider,
  ssoRuntimeIdentity,
  saveSsoProvider,
} from "./sso-settings.ts";
import {
  changeSsoDomains,
  checkSsoDomainChange,
  readSsoDomains,
  verifySsoDomains,
} from "./sso-domains.ts";
import { appLoginClientId, readAppLogin, registerAppLogin } from "./app-login-client.ts";
import { organizationSettings } from "./schema.ts";
import type { Observation } from "./observation.ts";

export const configuredAppSignInOrganizations = (database: Database) =>
  database
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(
      or(
        isNotNull(organizationSettings.appClientSecret),
        eq(organizationSettings.ssoRequired, true),
      ),
    );

const requireAdmin = (principal: Principal, organizationId: string) => {
  if (!principal.application.admin || principal.application.organizationId !== organizationId)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Organization administrator access is required",
    });
};

const createOrganizationSettingsService = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  appSignIn: AppSignIn | null,
  organizationId: string,
  emailSignIn: boolean,
) => {
  const lockSettings = async (transaction: DatabaseExecutor) => {
    await transaction
      .insert(organizationSettings)
      .values({
        organizationId,
        settings: installationSettings.parse({}),
      })
      .onConflictDoNothing();
    await transaction
      .select({ organizationId: organizationSettings.organizationId })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .for("update");
  };

  const requireEditable = async (browser: boolean) => {
    if (browser && (await readOrganizationSettings(database, organizationId)).externallyManaged)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message:
          "Configuration is externally managed. Turn off external management to edit it in the UI.",
      });
  };

  const readCurrent = async (transaction: DatabaseExecutor) => {
    const [stored] = await transaction
      .select({
        settings: organizationSettings.settings,
        directorySecret: organizationSettings.directorySecret,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId));

    const state = { settings: installationSettings.parse(stored?.settings ?? {}) };

    const errors: string[] = [];
    const sso = await readSsoConfiguration(transaction, encryptionKey, organizationId);
    let identity: z.infer<typeof companyIdentity> | null = null;

    try {
      if (sso?.domainVerified && sso.required) {
        identity = ssoRuntimeIdentity(sso);

        if (state.settings.directory)
          identity.directory = {
            clientId: state.settings.directory.clientId,
            clientSecret: await decryptSecret(encryptionKey, stored?.directorySecret ?? ""),
          };
      }
    } catch (cause) {
      errors.push(
        cause instanceof InvalidOperation ? cause.message : "Company sign-in could not be prepared",
      );
    }

    const domains = await readSsoDomains(transaction, organizationId);

    return { state, identity, sso, domains, errors };
  };

  const resolve = () =>
    database.transaction(readCurrent, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });

  const inspect = async (publish = false) => {
    const resolved = await database.transaction(
      async (transaction) => {
        // Keep publication ordered across hosted requests and self-hosted processes.
        // Ordinary readers use MVCC and do not wait for this writer's row lock.
        if (publish) await lockSettings(transaction);
        const current = await readCurrent(transaction);

        let fallback =
          !current.identity && emailSignIn
            ? await readAppLogin(transaction, configuration, encryptionKey, organizationId)
            : null;

        if (publish && emailSignIn && !current.identity) {
          await registerAppLogin(transaction, configuration, encryptionKey, organizationId);
          fallback = await readAppLogin(transaction, configuration, encryptionKey, organizationId);
        }

        if (publish && current.identity)
          await transaction
            .update(oauthClient)
            .set({ disabled: true })
            .where(eq(oauthClient.clientId, appLoginClientId(organizationId)));
        const identity = current.identity ?? fallback;

        let expectedRevision = "";

        if (identity && appSignIn) {
          try {
            const secret = identity.management.clientSecret;

            const [company] = await transaction
              .select({ name: organization.name })
              .from(organization)
              .where(eq(organization.id, organizationId));

            expectedRevision = await appSignIn.revision(identity, secret, company?.name);

            if (publish) await appSignIn.publish(identity, secret, company?.name);
          } catch (cause) {
            current.errors.push(
              cause instanceof InvalidOperation
                ? cause.message
                : "App sign-in could not be prepared",
            );
          }
        }

        return { ...current, revision: expectedRevision };
      },
      {
        isolationLevel: publish ? "read committed" : "repeatable read",
        accessMode: publish ? "read write" : "read only",
      },
    );

    const current =
      appSignIn && resolved.revision
        ? await appSignIn.status(resolved.revision)
        : {
            revision: "",
            state: "waiting" as const,
            message:
              resolved.sso && !resolved.sso.domainVerified
                ? "Verify the company domain before publishing its app sign-in configuration."
                : "App sign-in has no publishable configuration.",
          };

    const activation =
      resolved.revision && current.revision !== resolved.revision
        ? {
            revision: resolved.revision,
            state: "applying" as const,
            message: "The sign-in service is applying the configuration",
          }
        : current;

    const connection = resolved.sso;

    const sso = connection
      ? {
          providerId: connection.providerId,
          appIdentityType: connection.appIdentityType,
          issuer: connection.issuer,
          // Providers created outside Widefleet's settings have no domain list.
          domain: resolved.domains.length
            ? resolved.domains.map((entry) => entry.domain).join(",")
            : connection.domain,
          domainVerified: connection.domainVerified,
          oidcConfig: {
            clientId: connection.oidcConfig.clientId,
            pkce: connection.oidcConfig.pkce,
            scopes: connection.oidcConfig.scopes,
            mapping: connection.oidcConfig.mapping,
          },
        }
      : null;

    return {
      settings: resolved.state.settings,
      ssoDomains: resolved.domains,
      sso,
      ssoRequired: Boolean(connection?.domainVerified && connection.required),
      managementCallbackUrl: sso
        ? `${configuration.PLATFORM_URL}/api/auth/sso/callback/${sso.providerId}`
        : null,
      appCallbackUrl: appSignIn?.callbackUrl ?? appCallbackUrl(configuration, organizationId),
      activation,
      error: resolved.errors.length ? resolved.errors.join(". ") : null,
    };
  };

  const prepare = async (input: z.infer<typeof settingsInput>) => {
    const next = settingsInput.parse(input);

    if (!emailSignIn && !next.sso)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Configure a replacement company login before removing the active provider",
      });

    if (next.directory && !next.directory.clientSecret) {
      const [saved] = await database
        .select({ secret: organizationSettings.directorySecret })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId));

      if (!saved?.secret)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Enter the directory client secret",
        });
    }

    if (next.sso?.appIdentityType === "google" && next.sso.issuer !== "https://accounts.google.com")
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Use https://accounts.google.com as the Google Workspace issuer",
      });

    const domains =
      next.sso?.domain === undefined
        ? (await readSsoDomains(database, organizationId)).map((entry) => entry.domain)
        : parseCompanyDomains(next.sso.domain);

    if (next.sso && !domains.length && !(await readSsoProvider(database, organizationId)))
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Enter a company email domain",
      });

    // Rejects an invalid domain list before the connection itself is saved.
    if (next.sso?.domain !== undefined)
      await checkSsoDomainChange(
        database,
        organizationId,
        { replace: domains },
        next.sso.appIdentityType,
      );

    // Google app sign-in requests one Workspace domain from Google and checks its `hd` claim.
    if (next.sso?.appIdentityType === "google" && domains.length > 1)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Google Workspace app identity supports one company email domain",
      });

    if (next.directory && next.sso?.appIdentityType !== "entra")
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Microsoft Graph directory search requires Entra app identity",
      });

    return appSignIn
      ? appSignIn.plan(null)
      : {
          restartRequired: false,
          message:
            "Management sign-in will be updated. App sign-in is not connected to this installation.",
        };
  };

  const save = async (
    input: z.infer<typeof settingsInput>,
    credential?: OrganizationCredential,
  ) => {
    const next = settingsInput.parse(input);

    if (credential) await saveSsoProvider(database, organizationId, next.sso, credential);
    else if (next.sso)
      throw new InvalidOperation({
        code: "FORBIDDEN",
        message: "Sign in before configuring the SSO provider",
      });
    await database.transaction(async (transaction) => {
      await lockSettings(transaction);

      const [current] = await transaction
        .select({ directorySecret: organizationSettings.directorySecret })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId));

      const directorySecret = !next.directory
        ? null
        : next.directory.clientSecret
          ? await encryptSecret(encryptionKey, next.directory.clientSecret)
          : current?.directorySecret;

      if (next.directory && !directorySecret)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "Enter the directory client secret",
        });
      const directory = next.directory ? { clientId: next.directory.clientId } : null;

      await transaction
        .update(organizationSettings)
        .set({
          directorySecret: directorySecret ?? null,
          ssoRequired: next.sso ? undefined : false,
          settings: installationSettings.parse({
            directory,
            externallyManaged: next.externallyManaged,
          }),
        })
        .where(eq(organizationSettings.organizationId, organizationId));
    });

    return inspect(true);
  };

  return {
    resolve,
    inspect,
    initialize: async (
      input: z.infer<typeof settingsInput>,
      credential?: OrganizationCredential,
    ) => {
      await prepare(input);

      return save(input, credential);
    },
    read: async (principal: Principal) => {
      requireAdmin(principal, organizationId);

      return inspect();
    },
    plan: async (principal: Principal, input: z.infer<typeof settingsInput>) => {
      requireAdmin(principal, organizationId);

      return prepare(input);
    },
    update: async (
      principal: Principal,
      input: z.infer<typeof settingsUpdate>,
      browser: boolean,
      credential: OrganizationCredential,
    ) => {
      requireAdmin(principal, organizationId);
      await requireEditable(browser);
      const { acknowledgeRestart, ...next } = settingsUpdate.parse(input);
      const plan = await prepare(next);

      if (plan.restartRequired && !acknowledgeRestart)
        throw new InvalidOperation({ code: "CONFLICT", message: plan.message });

      return save(next, credential);
    },
    setExternalManagement: async (principal: Principal, enabled: boolean) => {
      requireAdmin(principal, organizationId);
      await database.transaction(async (transaction) => {
        await lockSettings(transaction);
        await transaction
          .update(organizationSettings)
          .set({
            settings: sql`jsonb_set(${organizationSettings.settings}, '{externallyManaged}', to_jsonb(${enabled}::boolean))`,
          })
          .where(eq(organizationSettings.organizationId, organizationId));
      });

      return inspect();
    },
    domainVerification: async (principal: Principal) => {
      requireAdmin(principal, organizationId);

      const records = (await readSsoDomains(database, organizationId)).flatMap((entry) =>
        entry.record ? [{ domain: entry.domain, ...entry.record }] : [],
      );

      const [first] = records;

      if (!first)
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Every company email domain is verified",
        });

      return { name: first.name, type: first.type, value: first.value, records };
    },
    addDomain: async (principal: Principal, domain: string, browser: boolean) => {
      requireAdmin(principal, organizationId);
      await requireEditable(browser);
      await database.transaction(async (transaction) => {
        await lockSettings(transaction);

        if (
          (await readSsoDomains(transaction, organizationId)).some(
            (entry) => entry.domain === domain,
          )
        )
          throw new InvalidOperation({
            code: "CONFLICT",
            message: `${domain} is already a company email domain`,
          });
        await changeSsoDomains(transaction, organizationId, { add: [domain] });
      });

      return inspect();
    },
    removeDomain: async (principal: Principal, domain: string, browser: boolean) => {
      requireAdmin(principal, organizationId);
      await requireEditable(browser);

      await database.transaction(async (transaction) => {
        await lockSettings(transaction);

        if (
          !(await readSsoDomains(transaction, organizationId)).some(
            (entry) => entry.domain === domain,
          )
        )
          throw new InvalidOperation({
            code: "NOT_FOUND",
            message: `${domain} is not a company email domain`,
          });
        await changeSsoDomains(transaction, organizationId, { remove: [domain] });
      });

      return inspect();
    },
    verifyDomain: async (principal: Principal, domain?: string) => {
      requireAdmin(principal, organizationId);
      const result = await verifySsoDomains(database, organizationId, domain);

      if (result.verified.length && (await readSsoProvider(database, organizationId))?.required)
        await inspect(true);

      if (result.missing.length)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: `No matching TXT record was found for ${result.missing.join(", ")}. DNS changes can take a while to appear; try again later.`,
        });

      return { success: true };
    },
    activateSso: async (principal: Principal) => {
      requireAdmin(principal, organizationId);
      await database.transaction(async (transaction) => {
        await lockSettings(transaction);
        const provider = await readSsoConfiguration(transaction, encryptionKey, organizationId);

        if (!provider?.domainVerified)
          throw new InvalidOperation({
            code: "CONFLICT",
            message: "Verify the company domain before activating SSO",
          });
        await transaction
          .update(organizationSettings)
          .set({ ssoRequired: true })
          .where(eq(organizationSettings.organizationId, organizationId));
      });

      return inspect(true);
    },
  };
};

export const createSettingsService = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  appSignIn: (organizationId: string) => AppSignIn | null,
  emailSignIn = false,
  observation?: Observation,
) => {
  const signInEnabled = emailSignIn || configuration.LOGIN_CODE_DELIVERY === "console";

  const scoped = (organizationId: string) =>
    createOrganizationSettingsService(
      configuration,
      database,
      encryptionKey,
      appSignIn(organizationId),
      organizationId,
      signInEnabled,
    );

  const installed = scoped(installationOrganizationId);

  return {
    resolve: (organizationId = installationOrganizationId) => scoped(organizationId).resolve(),

    inspect: installed.inspect,
    createOwner: async (input: z.infer<typeof setupOwner>, bootstrapPending = false) => {
      if (!bootstrapPending && (configuration.ARTIFACT_STORAGE_PROVIDER === "r2" || !signInEnabled))
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message:
            configuration.ARTIFACT_STORAGE_PROVIDER === "r2"
              ? "Use the initialization command to create the hosted administrator"
              : "Configure email delivery or LOGIN_CODE_DELIVERY=console before interactive setup",
        });
      const owner = await createInstallationOwner(database, input, bootstrapPending, observation);

      if (signInEnabled) await installed.inspect(true);

      return owner;
    },
    publish: (organizationId = installationOrganizationId) => scoped(organizationId).inspect(true),
    republish: async () => {
      for (const { organizationId } of await configuredAppSignInOrganizations(database)) {
        const result = await scoped(organizationId).inspect(true);

        if (result.error) throw new Error(result.error);
      }
    },
    initialize: (
      input: z.infer<typeof settingsInput>,
      organizationId = installationOrganizationId,
      credential?: OrganizationCredential,
    ) => scoped(organizationId).initialize(input, credential),
    read: (principal: Principal) => scoped(principal.application.organizationId).read(principal),
    plan: (principal: Principal, input: z.infer<typeof settingsInput>) =>
      scoped(principal.application.organizationId).plan(principal, input),
    update: (
      principal: Principal,
      input: z.infer<typeof settingsUpdate>,
      browser: boolean,
      credential: OrganizationCredential,
    ) => scoped(principal.application.organizationId).update(principal, input, browser, credential),
    setExternalManagement: (principal: Principal, enabled: boolean) =>
      scoped(principal.application.organizationId).setExternalManagement(principal, enabled),
    domainVerification: (principal: Principal) =>
      scoped(principal.application.organizationId).domainVerification(principal),
    addDomain: (principal: Principal, domain: string, browser: boolean) =>
      scoped(principal.application.organizationId).addDomain(principal, domain, browser),
    removeDomain: (principal: Principal, domain: string, browser: boolean) =>
      scoped(principal.application.organizationId).removeDomain(principal, domain, browser),
    verifyDomain: (principal: Principal, domain?: string) =>
      scoped(principal.application.organizationId).verifyDomain(principal, domain),
    activateSso: (principal: Principal) =>
      scoped(principal.application.organizationId).activateSso(principal),
  };
};
