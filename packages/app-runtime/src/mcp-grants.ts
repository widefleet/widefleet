import { DurableObject } from "cloudflare:workers";
import type { ParentEnvironment } from "./types.ts";

// The OAuth library keeps each grant's current and previous refresh token in
// one `grant:{userId}:{grantId}` record and rotates them on every refresh.
// Cloudflare KV serves reads from a per-location cache for up to 60 seconds,
// so a refresh that reaches another location shortly after a rotation can
// read an older record and reject the client's current token. On Cloudflare,
// grant records therefore live in one Durable Object per grant owner, which
// always reads its latest write. celld reads KV from the namespace's owning
// node and never returns stale values, so self-hosted runtimes keep grants in
// KV and have no binding.

const grantPrefix = "grant:";

// Set once per owner and never removed, so grants deleted from KV can never be
// imported again.
const importedKey = "imported";

// KV keys of imported grants, deleted by the alarm after `deleteAt`.
const migrationKey = "migration";

// Longer than KV's 60-second location cache, so a copy imported from a stale
// cache is replaced by the current record before KV keeps no copy.
const migrationWindow = 5 * 60 * 1000;

// The minimum KV allows, so imported reads leave the location cache sooner.
const importCacheTtl = 30;

// Key metadata stays serialized: the library reads it only from listings.
// `copied` marks an imported grant that has not been written since.
type Entry = {
  value: string;
  expiration: number | undefined;
  metadata: string | undefined;
  copied?: true;
};

type Migration = { deleteAt: number; names: string[] };

type ListedPage = {
  keys: { name: string; expiration: number | undefined; metadata: string | undefined }[];
  cursor: string | undefined;
};

const now = () => Math.floor(Date.now() / 1000);

const expired = (entry: Entry) => entry.expiration !== undefined && entry.expiration <= now();

// Grant IDs never contain `:`, so the last one separates the owner.
const grantOwner = (name: string) => {
  const rest = name.slice(grantPrefix.length);
  const separator = rest.lastIndexOf(":");

  if (!name.startsWith(grantPrefix) || separator <= 0 || separator === rest.length - 1)
    throw new Error("Invalid OAuth grant key");

  return rest.slice(0, separator);
};

export class McpGrants extends DurableObject<ParentEnvironment> {
  // Grants created before this store existed are copied from KV on first use,
  // so existing connections keep working. KV keeps its copies until the
  // migration window ends.
  private async load(owner: string) {
    if (await this.ctx.storage.get<boolean>(importedKey)) return;

    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<boolean>(importedKey)) return;
      const names: string[] = [];
      let cursor: string | undefined;

      do {
        const range: KVNamespaceListOptions = { prefix: `${grantPrefix}${owner}:` };

        if (cursor !== undefined) range.cursor = cursor;
        const page = await this.env.AUTH_CONFIG.list(range);

        for (const key of page.keys) {
          const value = await this.env.AUTH_CONFIG.get(key.name, { cacheTtl: importCacheTtl });

          if (value === null) continue;
          await this.ctx.storage.put<Entry>(key.name, {
            value,
            expiration: key.expiration,
            metadata: key.metadata === undefined ? undefined : JSON.stringify(key.metadata),
            copied: true,
          });
          names.push(key.name);
        }

        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);

      if (names.length > 0)
        await this.ctx.storage.put<Migration>(migrationKey, {
          deleteAt: Date.now() + migrationWindow,
          names,
        });

      await this.ctx.storage.put(importedKey, true);
      await this.schedule();
    });
  }

  // During the migration window, KV may still hold a newer record than the
  // imported copy. An imported grant follows KV until the object writes it.
  private async current(name: string) {
    const entry = await this.ctx.storage.get<Entry>(name);

    if (!entry?.copied || !(await this.ctx.storage.get<Migration>(migrationKey))) return entry;
    const value = await this.env.AUTH_CONFIG.get(name, { cacheTtl: importCacheTtl });
    // The KV read lets other calls run. Keep a write that happened meanwhile.
    const latest = await this.ctx.storage.get<Entry>(name);

    if (!latest?.copied || latest.value !== entry.value || value === entry.value) return latest;

    if (value === null) {
      await this.ctx.storage.delete(name);

      return undefined;
    }

    const refreshed: Entry = { ...latest, value };
    await this.ctx.storage.put(name, refreshed);

    return refreshed;
  }

  private entries(range: DurableObjectListOptions = { prefix: grantPrefix }) {
    return this.ctx.storage.list<Entry>(range);
  }

  private owned(owner: string, name: string) {
    if (grantOwner(name) !== owner) throw new Error("OAuth grant belongs to another owner");
  }

  // The alarm deletes expired grants and ends the migration window.
  private async schedule() {
    const migration = await this.ctx.storage.get<Migration>(migrationKey);

    const next = Math.min(
      migration?.deleteAt ?? Infinity,
      ...[...(await this.entries()).values()].map((entry) =>
        entry.expiration === undefined ? Infinity : entry.expiration * 1000,
      ),
    );

    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async read(owner: string, name: string) {
    this.owned(owner, name);
    await this.load(owner);
    const entry = await this.current(name);

    return entry && !expired(entry) ? entry : null;
  }

  async write(owner: string, name: string, entry: Entry) {
    this.owned(owner, name);
    await this.load(owner);
    await this.ctx.storage.put(name, entry);
    await this.schedule();
  }

  async remove(owner: string, name: string) {
    this.owned(owner, name);
    await this.load(owner);
    await this.ctx.storage.delete(name);
    await this.schedule();
  }

  async list(owner: string, options: { limit: number; cursor: string | undefined }) {
    await this.load(owner);

    const range: DurableObjectListOptions = {
      prefix: `${grantPrefix}${owner}:`,
      limit: options.limit + 1,
    };

    if (options.cursor !== undefined) range.startAfter = options.cursor;
    const page = [...(await this.entries(range)).entries()];
    const last = page.length > options.limit ? page.at(options.limit - 1)?.[0] : undefined;

    const keys = page
      .slice(0, options.limit)
      .flatMap(([name, entry]) =>
        expired(entry) ? [] : [{ name, expiration: entry.expiration, metadata: entry.metadata }],
      );

    return { keys, cursor: last } satisfies ListedPage;
  }

  override async alarm() {
    const migration = await this.ctx.storage.get<Migration>(migrationKey);

    if (migration && migration.deleteAt <= Date.now()) {
      // A failed delete fails the alarm, which Cloudflare retries.
      await Promise.all(migration.names.map((name) => this.env.AUTH_CONFIG.delete(name)));

      for (const name of migration.names) {
        const entry = await this.ctx.storage.get<Entry>(name);

        if (entry?.copied)
          await this.ctx.storage.put<Entry>(name, {
            value: entry.value,
            expiration: entry.expiration,
            metadata: entry.metadata,
          });
      }

      await this.ctx.storage.delete(migrationKey);
    }

    const removed = [...(await this.entries()).entries()].flatMap(([name, entry]) =>
      expired(entry) ? [name] : [],
    );

    // Durable Object storage deletes at most 128 keys per call.
    for (let start = 0; start < removed.length; start += 128)
      await this.ctx.storage.delete(removed.slice(start, start + 128));

    await this.schedule();
  }
}

// The OAuth library reads and writes its storage through these KV methods only.
// Grant records go to their owner's object; clients, tokens and transactions
// remain in KV.
export const mcpOAuthStorage = (environment: ParentEnvironment) => {
  const kv = environment.AUTH_CONFIG;
  const objects = environment.WIDEFLEET_MCP_GRANTS;

  if (!objects) return kv;
  const object = (owner: string) => objects.get(objects.idFromName(owner));

  const listedOwner = (prefix: string) => {
    const owner = prefix.slice(grantPrefix.length, -1);

    if (!prefix.endsWith(":") || owner.length === 0 || owner.includes(":"))
      throw new Error("OAuth grants can only be listed per owner");

    return owner;
  };

  return {
    get: async (name: string, options?: { type?: "text" | "json"; cacheTtl?: number }) => {
      if (!name.startsWith(grantPrefix))
        return options?.type === "json"
          ? kv.get(name, { ...options, type: "json" })
          : kv.get(name, { ...options, type: "text" });
      const owner = grantOwner(name);
      const entry = await object(owner).read(owner, name);

      if (!entry) return null;
      const parsed: unknown = options?.type === "json" ? JSON.parse(entry.value) : entry.value;

      return parsed;
    },
    put: async (name: string, value: string, options: KVNamespacePutOptions = {}) => {
      if (!name.startsWith(grantPrefix)) return kv.put(name, value, options);
      const owner = grantOwner(name);
      const ttl = options.expirationTtl;
      const metadata: unknown = options.metadata;

      return object(owner).write(owner, name, {
        value,
        expiration: options.expiration ?? (ttl === undefined ? undefined : now() + ttl),
        metadata:
          metadata === undefined || metadata === null ? undefined : JSON.stringify(metadata),
      });
    },
    delete: async (name: string) => {
      if (!name.startsWith(grantPrefix)) return kv.delete(name);
      const owner = grantOwner(name);

      return object(owner).remove(owner, name);
    },
    list: async (options: KVNamespaceListOptions = {}) => {
      const prefix = options.prefix ?? "";

      if (prefix.startsWith(grantPrefix)) {
        const owner = listedOwner(prefix);

        const page = await object(owner).list(owner, {
          limit: options.limit ?? 1000,
          cursor: options.cursor ?? undefined,
        });

        const keys = page.keys.map((key) => {
          const metadata: unknown =
            key.metadata === undefined ? undefined : JSON.parse(key.metadata);

          return { name: key.name, expiration: key.expiration, metadata };
        });

        return page.cursor === undefined
          ? { keys, list_complete: true }
          : { keys, list_complete: false, cursor: page.cursor };
      }

      // A broader prefix would silently omit every grant.
      if (grantPrefix.startsWith(prefix))
        throw new Error("OAuth grants can only be listed per owner");

      return kv.list(options);
    },
  };
};
