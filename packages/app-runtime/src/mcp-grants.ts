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

const importedKey = "imported";

// Key metadata stays serialized: the library reads it only from listings.
type Entry = { value: string; expiration: number | undefined; metadata: string | undefined };

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
  // Grants created before this store existed are moved out of KV on first use,
  // so existing connections keep working and stop reading stale copies.
  private async load(owner: string) {
    if (await this.ctx.storage.get<boolean>(importedKey)) return;

    await this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<boolean>(importedKey)) return;
      const imported: string[] = [];
      let cursor: string | undefined;

      do {
        const range: KVNamespaceListOptions = { prefix: `${grantPrefix}${owner}:` };

        if (cursor !== undefined) range.cursor = cursor;
        const page = await this.env.AUTH_CONFIG.list(range);

        for (const key of page.keys) {
          const value = await this.env.AUTH_CONFIG.get(key.name);

          if (value === null) continue;
          await this.ctx.storage.put<Entry>(key.name, {
            value,
            expiration: key.expiration,
            metadata: key.metadata === undefined ? undefined : JSON.stringify(key.metadata),
          });
          imported.push(key.name);
        }

        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);

      await this.ctx.storage.put(importedKey, true);

      if (imported.length === 0) return;
      await this.schedule();
      await Promise.all(imported.map((name) => this.env.AUTH_CONFIG.delete(name)));
    });
  }

  private entries(range: DurableObjectListOptions = { prefix: grantPrefix }) {
    return this.ctx.storage.list<Entry>(range);
  }

  private owned(owner: string, name: string) {
    if (grantOwner(name) !== owner) throw new Error("OAuth grant belongs to another owner");
  }

  // Expired grants are removed at the earliest expiry. An owner without grants
  // leaves no storage behind.
  private async schedule() {
    const entries = [...(await this.entries()).values()];

    if (entries.length === 0) {
      await this.ctx.storage.deleteAll();

      return;
    }

    const next = Math.min(...entries.map((entry) => entry.expiration ?? Infinity));

    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next * 1000);
    else await this.ctx.storage.deleteAlarm();
  }

  async read(owner: string, name: string) {
    this.owned(owner, name);
    await this.load(owner);
    const entry = await this.ctx.storage.get<Entry>(name);

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
