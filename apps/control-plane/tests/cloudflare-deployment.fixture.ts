import { createHash } from "node:crypto";
import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { deploymentCommand } from "../src/lib/server/deployment-execution.ts";
import type { Database } from "../src/lib/server/database.ts";
import { apps, artifacts, fleets } from "../src/lib/server/schema.ts";

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
    crons?: string[];
    consumers?: z.infer<typeof contract.queueConsumer>[];
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

  const [record] = await database.select().from(apps).where(eq(apps.id, appId));

  if (!record) throw new Error("Missing deployment fixture app");

  const artifact = contract.artifact.parse({
    id: crypto.randomUUID(),
    appId,
    metadata: {
      main_module: "app.js",
      compatibility_date: "2026-10-01",
      assets: { binding: "ASSETS", upload_session: crypto.randomUUID() },
      crons: options.crons ?? [],
      queue_consumers: options.consumers ?? [],
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

  const command = deploymentCommand.parse({
    kind: "deploy",
    id: crypto.randomUUID(),
    appId,
    artifactId: artifact.id,
    requestId: crypto.randomUUID(),
    rollback: false,
    createdAt: new Date().toISOString(),
  });

  if (command.kind !== "deploy") throw new Error("Fixture requires a deploy command");

  return {
    appId,
    hostname: record.hostname,
    artifact,
    command,
    deploymentId: command.id,
    fleetId: record.fleetId,
    source,
  };
};

export const capabilitiesSource = `
import { WorkflowEntrypoint } from 'cloudflare:workers';
export class ExampleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    if (event.payload?.large) return step.do('large', () => String.fromCharCode(34).repeat(300000));
    await step.do('record', () => this.env.KV.put('workflow:' + event.instanceId, 'prepared'));
    if (event.payload?.wait) await step.waitForEvent('continue', {type:'continue', timeout:'5 minutes'});
    return step.do('result', () => 42);
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/kv' && request.method === 'PUT') await env.KV.put('value', await request.text());
    if (path === '/queue' && request.method === 'POST') await env.JOBS.send({value:await request.text()});
    return Response.json(await env.KV.get(path.slice(1) === 'kv' ? 'value' : path.slice(1)));
  },
  async scheduled(controller, env) { await env.KV.put('cron', controller.cron); },
  async queue(batch, env) {
    for (const message of batch.messages) { await env.KV.put('queue', batch.queue + ':' + message.body.value); message.ack(); }
  }
};`;
