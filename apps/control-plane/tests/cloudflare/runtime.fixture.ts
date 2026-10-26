export const appSource = `
import { env as importedEnv, WorkflowEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { NonRetryableError } from 'cloudflare:workflows';

export class ExampleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const mode = event.payload.mode;
    const record = async (label, context) => {
      await this.env.DB.exec('CREATE TABLE IF NOT EXISTS workflow_attempts (id TEXT, label TEXT, attempt INTEGER)');
      await this.env.DB.prepare('INSERT INTO workflow_attempts VALUES (?, ?, ?)').bind(event.instanceId, label, context.attempt).run();
      return context;
    };
    if (mode === 'fatal' || mode === 'caught') {
      try {
        return await step.do('failure', { retries: { limit: 2, delay: 10 } }, async context => {
          await record('failure', context);
          throw new NonRetryableError('permanent fixture', 'ApplicationFailure');
        });
      } catch (error) {
        if (mode === 'fatal') throw error;
        await this.env.KV.put('caught:' + event.instanceId, JSON.stringify({ name: error.name, message: error.message, permanent: error instanceof NonRetryableError }));
        await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
        return { name: error.name, message: error.message, permanent: error instanceof NonRetryableError };
      }
    }
    if (mode === 'retry') {
      return step.do('retry', { retries: { limit: 2, delay: 10 } }, async context => {
        await record('retry', context);
        if (context.attempt < 3) throw new Error('temporary fixture');
        return { step: context.step, attempt: context.attempt };
      });
    }
    if (mode === 'parallel') {
      return Promise.all([
        ...[1, 2].map(value => step.do('same', async context => {
          await record('same', context);
          return { value, step: context.step };
        })),
        step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' }),
      ]);
    }
    if (mode === 'sleep') {
      await step.sleep('nap', 1);
      const deadline = await step.do('deadline', async () => new Date(Date.now() + 20));
      await step.sleepUntil('until', deadline);
      return step.do('awake', context => record('awake', context));
    }
    if (mode === 'nested') return step.do('outer', () => step.do('inner', async () => 'invalid'));
    if (mode === 'permissions') {
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return step.do('inspect', async () => ({ connector: !!this.env.CONNECTOR, secret: this.env.PRIVATE_ROOT_SECRET ?? null }));
    }
    if (mode === 'restart') {
      await step.do('first', context => record('first', context));
      return step.do('second', context => record('second', context));
    }
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
    if (url.pathname === '/logs') {
      console.info('fixture plain log', { value: 42 });
      console.error(JSON.stringify({ widefleet: 1, source: 'browser', kind: 'error', message: 'older browser', buildId: 'older-build' }));
      return new Response('logged');
    }
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
      if (request.method === 'POST') return Response.json({ id: (await env.WORKFLOW.create({ id, params: { value: 20, mode: url.searchParams.get('mode') } })).id });
      const instance = await env.WORKFLOW.get(id);
      if (request.method === 'PUT') {
        const action = url.searchParams.get('action');
        if (action === 'pause') await instance.pause();
        else if (action === 'resume') await instance.resume();
        else if (action === 'restart') await instance.restart({ from: { name: 'second', type: 'do', count: 1 } });
        else await instance.sendEvent({ type: 'continue', payload: { add: 21 } });
        return Response.json({ ok: true });
      }
      return Response.json(await instance.status());
    }
    if (url.pathname === '/workflow/steps') return Response.json((await env.DB.prepare('SELECT id FROM workflow_steps ORDER BY id').all()).results);
    if (url.pathname === '/workflow/error') return Response.json(await env.KV.get('caught:' + url.searchParams.get('id'), 'json'));
    if (url.pathname === '/workflow/attempts') {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS workflow_attempts (id TEXT, label TEXT, attempt INTEGER)');
      return Response.json((await env.DB.prepare('SELECT label, attempt FROM workflow_attempts WHERE id = ? ORDER BY rowid').bind(url.searchParams.get('id')).all()).results);
    }
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
import { WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
export * from './runtime.js';
const logRecords = [];
for (const level of ['log', 'debug', 'info', 'warn', 'error']) {
  const originalLog = console[level];
  console[level] = (...args) => {
    if (args[0]?.widefleetLog === 1) logRecords.push(args[0]);
    else originalLog(...args);
  };
}

export class ConnectorGateway extends WorkerEntrypoint {
  invoke(method, [a, b]) { return a + b; }
}

export class PauseWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const key = 'pause:' + event.instanceId;
    try {
      await step.do('started', () => this.env.KV.put(key + ':started', 'true'));
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return 'recovered';
    } catch (error) {
      try {
        await step.do('record-failure', () => this.env.KV.put(key + ':failed', 'true'));
      } finally {
        // Observe that the catch has settled before checking for forbidden side effects.
        await this.env.KV.put(key + ':caught', 'true');
      }
      throw error;
    }
  }
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
    url.protocol = "https:";
    url.port = "";
    request = new Request(url, request);
    if (request.headers.get('x-fixture-management') === 'true') {
      request.headers.delete('x-fixture-management');
      return env.RUNTIME_MANAGEMENT.fetch(request);
    }
    if (url.pathname === '/fixture/logs') return Response.json(logRecords);
    if (url.pathname === '/fixture/availability') {
      const { organizationId = 'widefleet', value } = await request.json();
      const key = 'organizations/' + organizationId + '/http-availability';
      if (value === null) await env.AUTH_CONFIG.delete(key);
      else await env.AUTH_CONFIG.put(key, value);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/fixture/pause-workflow') {
      const id = url.searchParams.get('id');
      const instance = request.method === 'POST'
        ? await env.PAUSE_WORKFLOW.create({ id })
        : await env.PAUSE_WORKFLOW.get(id);
      if (request.method === 'PUT') {
        if (url.searchParams.get('action') === 'pause') await instance.pause();
        else {
          await instance.resume();
          await instance.sendEvent({ type: 'continue', payload: null });
        }
      }
      const state = await instance.status();
      for (const name of ['started', 'failed', 'caught'])
        state[name] = await env.KV.get('pause:' + id + ':' + name) === 'true';
      return Response.json(state);
    }
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
      await env.AUTH_CONFIG.put('apps/' + app.hostname, JSON.stringify({organizationId:"widefleet",appId:app.appId, access:{revision:1,groups:[]}}));
      return new Response(null, { status: 204 });
    }
    const mode = request.headers.get('x-fixture-storage-mode');
    if (!mode) return runtime.fetch(request, env, ctx);
    let hostStarted = false;
    let statusStarted = false;
    const response = await runtime.fetch(request, {
      ...env,
      WIDEFLEET_HTTP_AVAILABILITY: mode === 'disabled' ? '' : env.WIDEFLEET_HTTP_AVAILABILITY,
      WIDEFLEET_PACKAGES: new Proxy(env.WIDEFLEET_PACKAGES, {
        get(target, name) {
          if (name === 'get') return async (...args) => {
            if (!args[0].startsWith('hosts/')) return target.get(...args);
            hostStarted = true;
            const object = await target.get(...args);
            if (mode === 'parallel' && !statusStarted) throw new Error('KV read did not start alongside R2');
            return object;
          };
          const value = target[name];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
      AUTH_CONFIG: {
        async get(key, ...args) {
          if (key.endsWith('/http-availability')) {
            statusStarted = true;
            if (mode === 'parallel' && !hostStarted) throw new Error('R2 read has not started');
            if (mode === 'kv-error' || mode === 'disabled') throw new Error('Synthetic KV failure');
          }
          return env.AUTH_CONFIG.get(key, ...args);
        },
      },
    }, ctx);
    if (mode === 'parallel' && !statusStarted) throw new Error('Missing KV read');
    return response;
  },
};
`;
