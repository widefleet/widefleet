import { createHash } from "node:crypto";
import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "../src/lib/server/database.ts";
import { apps, artifacts, deployments, fleets, jobs } from "../src/lib/server/schema.ts";

export const deploymentSource = `export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/resources') {
    await env.DB.exec('CREATE TABLE IF NOT EXISTS records (value TEXT)');
    if (request.method === 'PUT') {
      const value = await request.text();
      await env.DB.prepare('INSERT INTO records VALUES (?)').bind(value).run();
      await env.FILES.put('value', value);
    }
    const file = await env.FILES.get('value');
    return Response.json({ rows: (await env.DB.prepare('SELECT value FROM records').all()).results, file: file ? await file.text() : null });
  }
  return new Response('deployed fixture');
} };`;

export const seedDeployment = async (
  database: Database,
  options: {
    appId?: string;
    source?: string;
    bindings?: z.infer<typeof contract.workerBinding>[];
    groups?: string[];
  } = {},
) => {
  const appId = options.appId ?? crypto.randomUUID();
  const source = options.source ?? deploymentSource;
  const [fleet] = await database.select().from(fleets).where(eq(fleets.name, "default"));

  if (!fleet) throw new Error("Missing default fleet");

  const hostname = `fixture-${appId}.example.test`;
  await database
    .insert(apps)
    .values({
      id: appId,
      slug: `fixture-${appId}`,
      displayName: "Deployment fixture",
      fleetId: fleet.id,
      ownerId: "fixture-owner",
      hostname,
      accessRevision: 1,
      accessGroups: options.groups ?? ["engineering"],
    })
    .onConflictDoNothing();

  const artifact = contract.artifact.parse({
    id: crypto.randomUUID(),
    appId,
    metadata: {
      main_module: "app.js",
      compatibility_date: "2026-10-01",
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
      bindings: options.bindings ?? [
        { type: "d1", name: "DB", database_name: "data" },
        { type: "r2_bucket", name: "FILES", bucket_name: "files" },
      ],
    },
    modules: [
      {
        name: "app.js",
        type: "esm",
        sha256: createHash("sha256").update(source).digest("hex"),
        size: Buffer.byteLength(source),
      },
    ],
    manifest: {},
  });

  await database.insert(artifacts).values(artifact);
  const deploymentId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await database
    .insert(deployments)
    .values({ id: deploymentId, appId, artifactId: artifact.id, requestId: jobId });
  await database
    .insert(jobs)
    .values({ id: jobId, appId, fleetId: fleet.id, deploymentId, kind: "deploy" });

  return { appId, hostname, artifact, jobId, deploymentId, fleetId: fleet.id, source };
};
