import { and, asc, eq, gt, isNotNull, sql, type AnyColumn } from "drizzle-orm";
import { storedAppSecrets } from "./app-secrets.ts";
import { ssoProvider } from "./auth-schema.ts";
import type { Database } from "./database.ts";
import { apps, organizationSettings } from "./schema.ts";
import {
  ciphertextKeyVersion,
  type SecretContext,
  type SecretEncryption,
} from "./secret-encryption.ts";

const pageSize = 100;

/** One stored ciphertext, named by its place in the row. */
type Slot = { slot: string; context: SecretContext; ciphertext: string };

/** A row's ciphertexts, and how to replace some of them if the row is unchanged. */
type StoredRow = {
  key: string;
  slots: Slot[];
  /** Writes the new ciphertexts by slot, only if the row still holds what was read. */
  replace: (next: ReadonlyMap<string, string>) => Promise<boolean>;
};

/**
 * A page of rows. `next` is the key to continue after, or `null` once the
 * location has no more rows. Rows without ciphertexts are skipped, so only the
 * database page tells whether more rows may follow.
 */
type Page = { rows: StoredRow[]; next: string | null };

type Location = (database: Database, after: string | null) => Promise<Page>;

const page = <T>(raw: T[], key: (row: T) => string, rows: StoredRow[]): Page => {
  const last = raw.at(-1);

  return { rows, next: raw.length === pageSize && last ? key(last) : null };
};

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

  return page(
    rows,
    (row) => row.id,
    rows.map((row) => {
      const secrets = storedAppSecrets.parse(row.secrets);

      return {
        key: row.id,
        slots: Object.entries(secrets).map(([name, ciphertext]) => ({
          slot: name,
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
                  Object.entries(secrets).map(([name, value]) => [name, next.get(name) ?? value]),
                ),
              })
              .where(and(eq(apps.id, row.id), unchanged(apps.secrets, JSON.stringify(row.secrets))))
              .returning({ id: apps.id }),
          ),
      };
    }),
  );
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

    return page(
      rows,
      (row) => row.organizationId,
      rows.flatMap(({ organizationId, ciphertext }) =>
        ciphertext === null
          ? []
          : [
              {
                key: organizationId,
                slots: [{ slot: column, context: { kind, organizationId }, ciphertext }],
                replace: async (next) =>
                  replaced(
                    await database
                      .update(organizationSettings)
                      .set({ [column]: next.get(column) ?? ciphertext })
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
      ),
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

    return page(
      rows,
      (row) => row.id,
      rows.flatMap(({ id, ciphertext }) =>
        ciphertext === null
          ? []
          : [
              {
                key: id,
                slots: [
                  { slot: field, context: { kind: "sso-provider-config", field }, ciphertext },
                ],
                replace: async (next) =>
                  replaced(
                    await database
                      .update(ssoProvider)
                      .set({ [field]: next.get(field) ?? ciphertext })
                      .where(and(eq(ssoProvider.id, id), eq(value, ciphertext)))
                      .returning({ id: ssoProvider.id }),
                  ),
              },
            ],
      ),
    );
  };

/** Every place that stores ciphertexts of the secret encryption service. */
const locations: Location[] = [
  appSecretValues,
  organizationSecret("directorySecret", "directory-client-secret"),
  organizationSecret("appClientSecret", "app-login-client-secret"),
  ssoConfiguration("oidcConfig"),
  ssoConfiguration("samlConfig"),
];

const eachRow = async function* (database: Database) {
  for (const location of locations)
    for (let key: string | null = null, more = true; more;) {
      const { rows, next } = await location(database, key);

      yield* rows;
      more = next !== null;
      key = next;
    }
};

/**
 * Counts per key version, plus values that do not decrypt. Key version IDs are
 * operator-chosen, so they are kept in a `Map`: no ID can collide with an
 * inherited object property.
 */
type Counts = { keyVersions: Map<string, number>; failed: number };

const tally = (counts: Counts, ciphertext: string) => {
  // A value without a readable `kid` cannot decrypt, so it counts only as failed.
  const version = ciphertextKeyVersion(ciphertext);

  if (version !== null) counts.keyVersions.set(version, (counts.keyVersions.get(version) ?? 0) + 1);
};

/**
 * Counts every stored secret by the key version that encrypted it. Each value
 * is decrypted, so `failed` counts values the installation cannot read.
 */
export const readSecretEncryption = async (database: Database, encryption: SecretEncryption) => {
  const counts: Counts = {
    keyVersions: new Map(encryption.keyVersions.map((id) => [id, 0])),
    failed: 0,
  };

  for await (const row of eachRow(database))
    for (const { context, ciphertext } of row.slots) {
      tally(counts, ciphertext);

      try {
        await encryption.decrypt(context, ciphertext);
      } catch {
        counts.failed += 1;
      }
    }

  return {
    activeKeyVersion: encryption.activeKeyVersion,
    // Own properties, even for IDs such as `__proto__`, so they reach the JSON output.
    keyVersions: Object.fromEntries(counts.keyVersions),
    failed: counts.failed,
  };
};

/**
 * Re-encrypts every stored secret that is not under the active key version's
 * key for its kind.
 * Values that already name the active version are decrypted to verify them.
 * Each row is replaced only if it still holds what was read, so a concurrent
 * write wins and is reported as `changed`. Running it again continues with
 * whatever remains.
 */
export const reencryptSecrets = async (
  database: Database,
  encryption: SecretEncryption,
  progress: (handled: number) => void = () => {},
) => {
  let reencrypted = 0;
  let changed = 0;
  let failed = 0;
  let handled = 0;

  for await (const row of eachRow(database)) {
    const next = new Map<string, string>();

    for (const { slot, context, ciphertext } of row.slots)
      try {
        const plaintext = await encryption.decrypt(context, ciphertext);

        if (!encryption.isCurrent(context, ciphertext))
          next.set(slot, await encryption.encrypt(context, plaintext));
      } catch {
        failed += 1;
      }

    if (next.size > 0) {
      if (await row.replace(next)) reencrypted += next.size;
      else changed += next.size;
    }

    handled += 1;

    if (handled % pageSize === 0) progress(handled);
  }

  return { reencrypted, changed, failed };
};

/** Whether stored secrets still use anything but the active version, or fail to decrypt. */
export const incomplete = (status: Awaited<ReturnType<typeof readSecretEncryption>>) =>
  status.failed > 0 ||
  Object.entries(status.keyVersions).some(
    ([id, values]) => id !== status.activeKeyVersion && values > 0,
  );
