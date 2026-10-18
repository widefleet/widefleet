import {
  identitySettings,
  installationSettings,
  settingsInput,
  settingsUpdate,
} from "@platform/contracts";
import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { appCallbackUrl, type AppSignIn } from "./app-sign-in.ts";
import { companyAccountProvider, companyIdentity } from "./company-identity.ts";
import { companyLoginRevision, type Authentication } from "./auth.ts";
import type { Configuration } from "./config.ts";
import type { Database, DatabaseExecutor } from "./database.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";
import { createInstallationSecrets } from "./installation-secrets.ts";
import { installationId, readInstallation } from "./installation-store.ts";
import { session, oauthRefreshToken } from "./auth-schema.ts";
import { installation, installationSecrets } from "./schema.ts";

const requireAdmin = (principal: Principal) => {
  if (!principal.admin)
    throw new InvalidOperation({
      code: "FORBIDDEN",
      message: "Platform administrator access is required",
    });
};

export const createSettingsService = (
  configuration: Configuration,
  database: Database,
  encryptionKey: string,
  appSignIn: AppSignIn | null,
) => {
  const secrets = createInstallationSecrets(database, encryptionKey);

  let revision = 0;

  const readCurrent = async (transaction: DatabaseExecutor) => {
    const snapshotSecrets = createInstallationSecrets(transaction, encryptionKey);

    const state = await readInstallation(transaction);
    const identity = state.settings.identity;

    if (!identity) return { state, identity: null, errors: [] };

    let resolved: z.infer<typeof companyIdentity> | null = null;
    const errors: string[] = [];

    try {
      resolved = companyIdentity.parse({
        provider: identity.provider,
        management: {
          clientId: identity.management.clientId,
          clientSecret: await snapshotSecrets.resolve(identity.management.secret),
        },
      });
    } catch (cause) {
      errors.push(
        cause instanceof InvalidOperation
          ? cause.message
          : "Management sign-in could not be prepared",
      );
    }

    if (identity.directory && resolved) {
      try {
        resolved.directory = {
          clientId: identity.directory.clientId,
          clientSecret: await snapshotSecrets.resolve(identity.directory.secret),
        };
      } catch (cause) {
        errors.push(
          cause instanceof InvalidOperation
            ? cause.message
            : "The group directory could not be prepared",
        );
      }
    }

    return { state, identity: resolved, errors };
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
        if (publish)
          await transaction
            .select({ id: installation.id })
            .from(installation)
            .where(eq(installation.id, installationId))
            .for("update");
        const current = await readCurrent(transaction);
        const identity = current.state.settings.identity;
        let expectedRevision = "";

        if (identity && appSignIn) {
          try {
            const secret = await createInstallationSecrets(transaction, encryptionKey).resolve(
              identity.apps.secret,
            );

            expectedRevision = await appSignIn.revision(identity, secret);

            if (publish) await appSignIn.publish(identity, secret);
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

    const current = appSignIn
      ? await appSignIn.status(resolved.revision)
      : {
          revision: "",
          state: "waiting" as const,
          message: "App sign-in is not connected to this installation.",
        };

    const activation =
      resolved.revision && current.revision !== resolved.revision
        ? {
            revision: resolved.revision,
            state: "applying" as const,
            message: "The sign-in service is applying the configuration",
          }
        : current;

    const identity = resolved.state.settings.identity;

    return {
      settings: resolved.state.settings,
      localPasswordEnabled: resolved.state.localPasswordEnabled,
      managementCallbackUrl: identity
        ? `${configuration.PLATFORM_URL}/api/auth/callback/${companyAccountProvider(identity)}`
        : null,
      appCallbackUrl: appSignIn?.callbackUrl ?? appCallbackUrl(configuration),
      activation,
      error: resolved.errors.length ? resolved.errors.join(". ") : null,
    };
  };

  const prepare = async (input: z.infer<typeof settingsInput>) => {
    const next = settingsInput.parse(input);
    const state = await readInstallation(database);

    if ((!state.localPasswordEnabled || state.settings.identity) && !next.identity)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Configure a replacement company login before removing the active provider",
      });

    if (next.identity) {
      await secrets.resolve(next.identity.management.secret);
      await secrets.resolve(next.identity.apps.secret);

      if (next.identity.directory) await secrets.resolve(next.identity.directory.secret);
    }

    return appSignIn
      ? appSignIn.plan(next.identity)
      : {
          restartRequired: false,
          message:
            "Management sign-in will be updated. App sign-in is not connected to this installation.",
        };
  };

  const save = async (input: z.infer<typeof settingsInput>) => {
    const next = settingsInput.parse(input);
    await database.transaction(async (transaction) => {
      // Keep replacing references and removing unused secret rows in one ordered transaction.
      await transaction
        .select({ id: installation.id })
        .from(installation)
        .where(eq(installation.id, installationId))
        .for("update");
      const identity = next.identity;

      const saved = identity
        ? identitySettings.parse({
            provider: identity.provider,
            management: {
              clientId: identity.management.clientId,
              secret: await secrets.save(transaction, identity.management.secret),
            },
            apps: {
              clientId: identity.apps.clientId,
              secret: await secrets.save(transaction, identity.apps.secret),
            },
            directory: identity.directory
              ? {
                  clientId: identity.directory.clientId,
                  secret: await secrets.save(transaction, identity.directory.secret),
                }
              : null,
          })
        : null;

      await transaction
        .update(installation)
        .set({
          settings: installationSettings.parse({
            identity: saved,
            externallyManaged: next.externallyManaged,
          }),
        })
        .where(eq(installation.id, installationId));

      const referenced = [saved?.management, saved?.apps, saved?.directory].flatMap((client) =>
        client?.secret.type === "stored" ? [client.secret.id] : [],
      );

      await transaction
        .delete(installationSecrets)
        .where(notInArray(installationSecrets.id, referenced));
    });

    revision++;

    return inspect(true);
  };

  return {
    get revision() {
      return revision;
    },
    resolve,
    inspect,
    initialize: async (input: z.infer<typeof settingsInput>) => {
      await prepare(input);

      return save(input);
    },
    read: async (principal: Principal) => {
      requireAdmin(principal);

      return inspect();
    },
    plan: async (principal: Principal, input: z.infer<typeof settingsInput>) => {
      requireAdmin(principal);

      return prepare(input);
    },
    update: async (
      principal: Principal,
      input: z.infer<typeof settingsUpdate>,
      browser: boolean,
    ) => {
      requireAdmin(principal);
      const state = await readInstallation(database);

      if (browser && state.settings.externallyManaged)
        throw new InvalidOperation({
          code: "FORBIDDEN",
          message:
            "Configuration is externally managed. Turn off external management to edit it in the UI.",
        });
      const next = { identity: input.identity, externallyManaged: input.externallyManaged };
      const plan = await prepare(next);

      if (plan.restartRequired && !input.acknowledgeRestart)
        throw new InvalidOperation({ code: "CONFLICT", message: plan.message });

      return save(next);
    },
    setExternalManagement: async (principal: Principal, enabled: boolean) => {
      requireAdmin(principal);
      await database
        .update(installation)
        .set({
          settings: sql`jsonb_set(${installation.settings}, '{externallyManaged}', to_jsonb(${enabled}::boolean))`,
        })
        .where(eq(installation.id, installationId));

      revision++;

      return inspect();
    },
    complete: async (principal: Principal, auth: Authentication, headers: Headers) => {
      requireAdmin(principal);
      const current = await auth.api.getSession({ headers });
      const resolved = await resolve();
      const state = resolved.state;
      const proof = companyLoginRevision({ ...configuration, IDENTITY: resolved.identity });

      if (!proof || !state.settings.identity || current?.session.companyConfiguration !== proof)
        throw new InvalidOperation({
          code: "CONFLICT",
          message: "Sign in with the linked company account to confirm administrator access first",
        });
      await database.transaction(async (transaction) => {
        await transaction
          .update(installation)
          .set({ localPasswordEnabled: false })
          .where(eq(installation.id, installationId));

        const localSessions = transaction
          .select({ id: session.id })
          .from(session)
          .where(eq(session.companyConfiguration, ""));

        await transaction
          .delete(oauthRefreshToken)
          .where(inArray(oauthRefreshToken.sessionId, localSessions));
        await transaction.delete(session).where(eq(session.companyConfiguration, ""));
      });

      revision++;

      return inspect();
    },
  };
};
