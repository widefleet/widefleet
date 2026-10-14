import { createHash } from "node:crypto";
import { connectorPackage } from "@platform/contracts";

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
    main: "connector.js",
    modules: [
      { name: "connector.js", source, sha256: createHash("sha256").update(source).digest("hex") },
    ],
    entrypoints: ["default", "Reader"],
    configuration: {
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      vars: { LABEL: "fixture" },
      d1_databases: [{ binding: "DB", database_name: "data" }],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "files" }],
      kv_namespaces: [{ binding: "KV", id: "cache" }],
      durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
    },
  });
