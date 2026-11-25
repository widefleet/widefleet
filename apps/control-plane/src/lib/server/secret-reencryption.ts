import * as contract from "@platform/contracts";
import { Result } from "better-result";
import { and, asc, eq, gt, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { storedAppSecrets } from "./app-secrets.ts";
import { ssoProvider } from "./auth-schema.ts";
import type { Database } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import type { Principal } from "./identity.ts";
import { apps, organizationSettings } from "./schema.ts";
import {
  ciphertextKeyVersion,
  type SecretContext,
  type SecretEncryption,
} from "./secret-encryption.ts";

const pageSize = 100;

/** A row's ciphertexts, and how to replace them if the row still holds them. */
type StoredRow = {
  key: string;
  secrets: { context: SecretContext; ciphertext: string }[];
  /** Writes `next` (old ciphertext to new) only if the row still holds what was read. */
  replace: (next: ReadonlyMap<string, string>) => Promise<boolean>;
};

/** Reads the page of rows after `after`, in key order. */
type Location = (database: Database, after: string | null) => Promise<StoredRow[]>;

const after = (column: AnyColumn, key: string | null) =>
  key === null ? undefined : gt(column, key);

const replaced = <T>(rows: T[]) => rows.length > 0;

/** Compares a JSON column with the serialized document read earlier. */
const unchanged = (column: AnyColumn, document: string) => sql`${column} = ${document}::jsonb`;

const appSecretValues: Location = async (database, key) => {
  const rows = await database
    .select({ id: apps.id, organizationId: apps.organizationId, secrets: apps.secrets })
    .from(apps)
    .where(and(sql`${apps.secrets} <> '{}'::jsonb`, after(apps.id, key)))
    .orderBy(asc(apps.id))
    .limit(pageSize);

  return rows.map((row) => {
    const secrets = storedAppSecrets.parse(row.secrets);

    return {
      key: row.id,
      secrets: Object.entries(secrets).map(([name, ciphertext]) => ({
        context: { kind: "app-secret", organizationId: row.organizationId, appId: row.id, name },
        ciphertext,
      })),
      // Leaves the secret revision alone: the values themselves do not change.
      replace: async (next) =>
        replaced(
          await database
            .update(apps)
            .set({
              secrets: Object.fromEntries(
                Object.entries(secrets).map(([name, value]) => [name, next.get(value) ?? value]),
              ),
            })
            .where(and(eq(apps.id, row.id), unchanged(apps.secrets, JSON.stringify(row.secrets))))
            .returning({ id: apps.id }),
        ),
    };
  });
};

const organizationSecret =
  (
    column: "directorySecret" | "appClientSecret",
    kind: "directory-client-secret" | "app-login-client-secret",
  ): Location =>
  async (database, key) => {
    const value = organizationSettings[column];

    const rows = await database
      .select({ organizationId: organizationSettings.organizationId, ciphertext: value })
      .from(organizationSettings)
      .where(and(isNotNull(value), after(organizationSettings.organizationId, key)))
      .orderBy(asc(organizationSettings.organizationId))
      .limit(pageSize);

    return rows.flatMap(({ organizationId, ciphertext }) =>
      ciphertext === null
        ? []
        : [
            {
              key: organizationId,
              secrets: [{ context: { kind, organizationId }, ciphertext }],
              replace: async (next) =>
                replaced(
                  await database
                    .update(organizationSettings)
                    .set({ [column]: next.get(ciphertext) ?? ciphertext })
                    .where(
                      and(
                        eq(organizationSettings.organizationId, organizationId),
                        eq(value, ciphertext),
                      ),
                    )
                    .returning({ organizationId: organizationSettings.organizationId }),
                ),
            },
          ],
    );
  };

const ssoConfiguration =
  (field: "oidcConfig" | "samlConfig"): Location =>
  async (database, key) => {
    const value = ssoProvider[field];

    const rows = await database
      .select({ id: ssoProvider.id, ciphertext: value })
      .from(ssoProvider)
      .where(and(isNotNull(value), after(ssoProvider.id, key)))
      .orderBy(asc(ssoProvider.id))
      .limit(pageSize);

    return rows.flatMap(({ id, ciphertext }) =>
      ciphertext === null
        ? []
        : [
            {
              key: id,
              secrets: [{ context: { kind: "sso-provider-config", field }, ciphertext }],
              replace: async (next) =>
                replaced(
                  await database
                    .update(ssoProvider)
                    .set({ [field]: next.get(ciphertext) ?? ciphertext })
                    .where(and(eq(ssoProvider.id, id), eq(value, ciphertext)))
                    .returning({ id: ssoProvider.id }),
                ),
            },
          ],
    );
  };

const legacyIdentity = z.looseObject({
  identity: z.looseObject({
    management: z.looseObject({ secret: z.looseObject({ ciphertext: z.string() }) }),
  }),
});

// Startup converts these documents to SSO providers; one can remain if that failed.
const legacyIdentitySecrets: Location = async (database, key) => {
  const rows = await database
    .select({
      organizationId: organizationSettings.organizationId,
      settings: organizationSettings.settings,
    })
    .from(organizationSettings)
    .where(
      and(
        sql`${organizationSettings.settings} ? 'identity'`,
        after(organizationSettings.organizationId, key),
      ),
    )
    .orderBy(asc(organizationSettings.organizationId))
    .limit(pageSize);

  return rows.flatMap((row) => {
    const parsed = legacyIdentity.safeParse(row.settings);

    if (!parsed.success) return [];
    const settings = parsed.data;
    const ciphertext = settings.identity.management.secret.ciphertext;

    return [
      {
        key: row.organizationId,
        secrets: [
          {
            context: { kind: "legacy-sso-client-secret", organizationId: row.organizationId },
            ciphertext,
          },
        ],
        replace: async (next) =>
          replaced(
            await database
              .update(organizationSettings)
              .set({
                settings: {
                  ...settings,
                  identity: {
                    ...settings.identity,
                    management: {
                      ...settings.identity.management,
                      secret: {
                        ...settings.identity.management.secret,
                        ciphertext: next.get(ciphertext) ?? ciphertext,
                      },
                    },
                  },
                },
              })
              .where(
                and(
                  eq(organizationSettings.organizationId, row.organizationId),
                  unchanged(organizationSettings.settings, JSON.stringify(row.settings)),
                ),
              )
              .returning({ organizationId: organizationSettings.organizationId }),
          ),
      },
    ];
  });
};

/** Every place that stores ciphertexts of the secret encryption service. */
const locations: Location[] = [
  appSecretValues,
  organizationSecret("directorySecret", "directory-client-secret"),
  organizationSecret("appClientSecret", "app-login-client-secret"),
  ssoConfiguration("oidcConfig"),
  ssoConfiguration("samlConfig"),
  legacyIdentitySecrets,
];

const eachRow = async function* (database: Database) {
  for (const location of locations) {
    let key: string | null = null;

    for (;;) {
      const page = await location(database, key);

      yield* page;

      const last = page.at(-1);

      if (!last || page.length < pageSize) break;
      key = last.key;
    }
  }
};

/**
 * Counts the stored secrets of each key version: the configured versions,
 * active first, then the legacy key and any version the installation lacks.
 */
export const readSecretEncryption = async (database: Database, encryption: SecretEncryption) => {
  const counts = new Map<string | null, number>(
    [...encryption.keyVersions, null].map((id) => [id, 0]),
  );

  for await (const row of eachRow(database))
    for (const { ciphertext } of row.secrets) {
      const version = ciphertextKeyVersion(ciphertext);
      counts.set(version, (counts.get(version) ?? 0) + 1);
    }

  return contract.secretEncryptionStatus.parse({
    activeKeyVersion: encryption.activeKeyVersion,
    keyVersions: [...counts].map(([id, values]) => ({
      id,
      values,
      active: id === encryption.activeKeyVersion,
      available: id === null || encryption.keyVersions.includes(id),
    })),
  });
};

/**
 * Re-encrypts every stored secret that another key version encrypted with the
 * active version. Each row is replaced only if it still holds the values read,
 * so concurrent writes win. Running it again continues with what remains.
 */
export const reencryptSecrets = async (database: Database, encryption: SecretEncryption) => {
  let reencrypted = 0;
  let changed = 0;
  let failed = 0;

  for await (const row of eachRow(database)) {
    const next = new Map<string, string>();

    for (const { context, ciphertext } of row.secrets) {
      if (ciphertextKeyVersion(ciphertext) === encryption.activeKeyVersion) continue;

      try {
        next.set(
          ciphertext,
          await encryption.encrypt(context, await encryption.decrypt(context, ciphertext)),
        );
      } catch {
        failed += 1;
      }
    }

    if (next.size === 0) continue;

    if (await row.replace(next)) reencrypted += next.size;
    else changed += next.size;
  }

  return contract.secretReencryption.parse({
    reencrypted,
    changed,
    failed,
    status: await readSecretEncryption(database, encryption),
  });
};

const forbidden = () =>
  Result.err(
    new InvalidOperation({ code: "FORBIDDEN", message: "Administrator permission is required" }),
  );

/**
 * Stored secrets belong to every organization, so only installation
 * administrators read and run re-encryption, through the API, CLI and UI.
 */
export const createSecretMaintenance = (database: Database, encryption: SecretEncryption) => ({
  status: async (principal: Principal) =>
    principal.admin ? Result.ok(await readSecretEncryption(database, encryption)) : forbidden(),
  reencrypt: async (principal: Principal) =>
    principal.admin ? Result.ok(await reencryptSecrets(database, encryption)) : forbidden(),
});
