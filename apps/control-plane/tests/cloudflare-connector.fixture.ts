import { createHash } from "node:crypto";
import { connectorPackage } from "@platform/contracts";
import type { z } from "zod";

const moduleBytes = new Map<string, Uint8Array>();

export const connectorModule = (
  name: string,
  type: z.infer<typeof connectorPackage>["modules"][number]["type"],
  source: string | Uint8Array,
) => {
  const bytes = source instanceof Uint8Array ? source : new TextEncoder().encode(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  moduleBytes.set(sha256, bytes);

  return { name, type, sha256, size: bytes.byteLength };
};

export const connectorFiles = (release: z.infer<typeof connectorPackage>) =>
  release.modules.map((module) => {
    const bytes = moduleBytes.get(module.sha256);

    if (!bytes) throw new Error("Missing connector fixture module");

    return { name: module.name, type: module.type, bytes };
  });

export const connectorUploadForm = (release: z.infer<typeof connectorPackage>) => {
  const form = new FormData();
  form.set("metadata", JSON.stringify(release.metadata));

  const mime = {
    esm: "application/javascript+module",
    sourcemap: "application/source-map+json",
    text: "text/plain",
    wasm: "application/wasm",
    data: "application/octet-stream",
  };

  for (const module of connectorFiles(release))
    form.append(
      module.name,
      new Blob([new Uint8Array(module.bytes)], { type: mime[module.type] }),
      module.name,
    );

  return form;
};

export const connectorSource = `
import {WorkerEntrypoint, DurableObject} from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment() { const n = (await this.ctx.storage.get("n") ?? 0) + 1; await this.ctx.storage.put("n", n); return n; }
}
export class Reader extends WorkerEntrypoint {
  #value = "private-field";
  read() { return this.#value; }
}
export default class Connector extends WorkerEntrypoint {
  #value = "connector";
  async inspect() {
    const secret = await this.env.WIDEFLEET_SECRETS.get("API_KEY");
    await this.env.DB.exec("CREATE TABLE IF NOT EXISTS entries (id INTEGER)");
    await this.env.DB.prepare("INSERT INTO entries VALUES (1)").run();
    const rows = await this.env.DB.prepare("SELECT COUNT(*) AS count FROM entries").first();
    await this.env.KV.put("value", this.#value);
    await this.env.BUCKET.put("value", this.#value);
    return {secret, count: rows.count, kv: await this.env.KV.get("value"), bucket: await (await this.env.BUCKET.get("value")).text(), counter: await this.env.COUNTER.get(this.env.COUNTER.idFromName("one")).increment()};
  }
  secret(name) { return this.env.WIDEFLEET_SECRETS.get(name); }
}
`;

export const connectorFixture = (name = "fixture-connector", source = connectorSource) =>
  connectorPackage.parse({
    protocol: 1,
    name,
    modules: [connectorModule("connector.js", "esm", source)],
    metadata: {
      main_module: "connector.js",
      entrypoints: ["default", "Reader"],
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "plain_text", name: "LABEL", text: "fixture" },
        { type: "d1", name: "DB", database_name: "data" },
        { type: "r2_bucket", name: "BUCKET", bucket_name: "files" },
        { type: "kv_namespace", name: "KV", id: "cache" },
      ],
      durable_objects: [{ name: "COUNTER", class_name: "Counter" }],
    },
  });

export const connectorDebugFixture = (name = "fixture-connector") => {
  const release = connectorFixture(name);

  const source = JSON.stringify({
    version: 3,
    sources: ["src/connector.ts"],
    names: ["inspect"],
    mappings: "AAAAA",
    sourcesContent: ["throw new Error('connector fixture');"],
  });

  release.modules.push(connectorModule("connector.js.map", "sourcemap", source));
  release.modules.sort((left, right) => left.name.localeCompare(right.name));
  release.metadata.debug = {
    build_id: "connector-fixture-build",
    source_maps: { "connector.js": "connector.js.map" },
  };

  return release;
};
