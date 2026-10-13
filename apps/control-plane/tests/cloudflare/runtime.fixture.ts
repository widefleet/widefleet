export const appSource = `
import { env as importedEnv, WorkflowEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';

export class ExampleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const value = await step.do('prepare', async () => {
      await this.env.DB.exec('CREATE TABLE IF NOT EXISTS workflow_steps (id TEXT PRIMARY KEY)');
      await this.env.DB.prepare('INSERT INTO workflow_steps VALUES (?)').bind(event.instanceId).run();
      return this.env.CONNECTOR.add(event.payload.value, 1);
    });
    const next = await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
    return step.do('finish', () => value + next.payload.add);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/env') return Response.json({ keys: Object.keys(env), imported: Object.keys(importedEnv) });
    if (url.pathname === '/throw') throw new Error('fixture application failure');
    if (url.pathname === '/connector') return Response.json(await env.CONNECTOR.add(20, 22));
    if (url.pathname === '/resources') {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS records (value TEXT)');
      if (request.method === 'PUT') {
        const value = await request.text();
        await env.DB.prepare('INSERT INTO records VALUES (?)').bind(value).run();
        await env.KV.put('value', value);
        await env.FILES.put('value', value, { httpMetadata: { contentType: 'text/plain' } });
      }
      const file = await env.FILES.get('value');
      return Response.json({
        rows: (await env.DB.prepare('SELECT value FROM records ORDER BY rowid').all()).results,
        kv: await env.KV.get('value'), file: file ? await file.text() : null,
      });
    }
    if (url.pathname === '/fetch') {
      const response = await fetch(url.searchParams.get('url'));
      return Response.json({ status: response.status, body: await response.text() });
    }
    if (url.pathname === '/tcp') {
      try {
        const socket = connect(url.searchParams.get('address'));
        await socket.opened;
        await socket.close();
        return Response.json({ connected: true });
      } catch (error) { return Response.json({ error: String(error) }); }
    }
    if (url.pathname === '/queue') {
      if (request.method === 'POST') await env.JOBS.send({ value: await request.text() });
      return Response.json(await env.KV.get('queue'));
    }
    if (url.pathname === '/cron') return Response.json(await env.KV.get('cron'));
    if (url.pathname === '/workflow') {
      const id = url.searchParams.get('id');
      if (request.method === 'POST') return Response.json({ id: (await env.WORKFLOW.create({ id, params: { value: 20 } })).id });
      const instance = await env.WORKFLOW.get(id);
      if (request.method === 'PUT') {
        await instance.sendEvent({ type: 'continue', payload: { add: 21 } });
        return Response.json({ ok: true });
      }
      return Response.json(await instance.status());
    }
    if (url.pathname === '/workflow/steps') return Response.json((await env.DB.prepare('SELECT id FROM workflow_steps ORDER BY id').all()).results);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) { ctx.waitUntil(env.KV.put('cron', controller.cron)); },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      ctx.waitUntil(env.KV.put('queue', message.body.value));
      message.ack();
    }
  },
};
`;

export const parentSource = `
import runtime from './runtime.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
export * from './runtime.js';

export class Connector extends WorkerEntrypoint {
  add(a, b) { return a + b; }
}

// Only the parent's final transport is replaced. Child fetches still cross the
// real globalOutbound binding and the unchanged network policy gateway.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://allowed.example.test') throw new Error('Unapproved fixture transport');
  if (request.redirect !== 'manual') throw new Error('Gateway followed redirects in the parent');
  if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://denied.example.test/private' } });
  return new Response('allowed fixture');
};

export default {
  ...runtime,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture/tcp') {
      const socket = connect(url.searchParams.get('address'));
      await socket.opened;
      await socket.close();
      return Response.json({ connected: true });
    }
    if (url.pathname === '/fixture/publish') {
      const { app, modules, assets } = await request.json();
      for (const module of modules) await env.WIDEFLEET_PACKAGES.put('apps/' + app.appId + '/modules/' + module.hash, module.source);
      for (const asset of assets) await env.WIDEFLEET_PACKAGES.put('apps/' + app.appId + '/assets/' + asset.hash, asset.source);
      await env.WIDEFLEET_PACKAGES.put('versions/' + app.appId + '/' + app.version + '.json', JSON.stringify(app));
      await env.WIDEFLEET_PACKAGES.put('hosts/' + app.hostname + '.json', JSON.stringify(app));
      return new Response(null, { status: 204 });
    }
    return runtime.fetch(request, env, ctx);
  },
};
`;
