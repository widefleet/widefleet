import * as contract from "@platform/contracts";
import { z } from "zod";
import type { createCloudflareProvisioner } from "./cloudflare-provisioning.ts";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const version = (name: string) => BigInt(/^[0-9]+/.exec(name)?.[0] ?? "0");

export const runCloudflareMigrations = async (
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  databaseId: string,
  input: z.infer<typeof contract.migrationRequest>,
) => {
  const request = contract.migrationRequest.parse(input);

  const files = request.files.toSorted((a, b) => {
    const left = version(a.name),
      right = version(b.name);

    return left < right ? -1 : left > right ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const query = async (sql: string) => {
    const results = z
      .array(z.object({ success: z.boolean(), results: z.array(z.unknown()).optional() }))
      .parse(
        await provisioner.request(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql }),
        }),
      );

    if (results.some((result) => !result.success)) throw new Error("Cloudflare D1 query failed");

    return results.flatMap((result) => result.results ?? []);
  };

  const exists = await query(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ${literal(request.table)} COLLATE NOCASE;`,
  );

  const applied = new Set<string>();

  if (exists.length) {
    for (let offset = 0; offset < files.length; offset += 100) {
      const names = files
        .slice(offset, offset + 100)
        .map((file) => literal(file.name))
        .join(",");

      const rows = z
        .array(z.object({ name: z.string() }))
        .parse(await query(`SELECT name FROM "${request.table}" WHERE name IN (${names});`));

      for (const row of rows) applied.add(row.name);
    }
  }

  if (request.action === "apply") {
    for (const file of files) {
      if (applied.has(file.name)) continue;
      // The API executes semicolon-separated statements as one transactional batch.
      // The unique history insert fences retries, including a lost success response.
      // Put it before user SQL so a trailing SQL comment cannot hide the insert.
      await query(
        `CREATE TABLE IF NOT EXISTS "${request.table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);\nINSERT INTO "${request.table}" (name) VALUES (${literal(file.name)});\n${file.sql ?? ""}`,
      );
      applied.add(file.name);
    }
  }

  return files.map((file) => ({ name: file.name, applied: applied.has(file.name) }));
};
