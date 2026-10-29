import { executionRecorder } from "./execution-limits.fixture.ts";

export const appSource = `
import { env as importedEnv, WorkflowEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { NonRetryableError } from 'cloudflare:workflows';

export class ExampleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const mode = event.payload.mode;
    if (mode === 'quota-event-timeout') {
      try {
        await step.waitForEvent('timeout', { type: 'continue', timeout: '2 seconds' });
        return 'unexpected event';
      } catch (error) {
        if (error.message !== 'Execution timed out after 2000ms') throw error;
        return { fallback: true, name: error.name, message: error.message };
      }
    }
    const record = async (label, context) => {
      await this.env.DB.exec('CREATE TABLE IF NOT EXISTS workflow_attempts (id TEXT, label TEXT, attempt INTEGER)');
      await this.env.DB.prepare('INSERT INTO workflow_attempts VALUES (?, ?, ?)').bind(event.instanceId, label, context.attempt).run();
      return context;
    };
    if (mode === 'quota-retry') {
      return step.do('quota-retry', { retries: { limit: 10000, delay: 1000 } }, async context => {
        await record('attempt', context);
        await fetch('https://allowed.example.test/gate?id=' + event.instanceId);
        throw new Error('retry after release');
      });
    }
    if (mode === 'quota-resource') {
      return step.do('quota-resource', { retries: { limit: 10000, delay: 1 } }, async context => {
        await record('attempt', context);
        await fetch('https://allowed.example.test/gate?id=' + event.instanceId);
        switch (event.payload.resource) {
          case 'd1': await this.env.DB.prepare('SELECT 1').all(); break;
          case 'kv': await this.env.KV.put('quota-write', 'unexpected'); break;
          case 'r2': await this.env.FILES.put('quota-write', 'unexpected'); break;
          case 'queue': await this.env.JOBS.send({ value: 'unexpected' }); break;
          case 'fetch': await fetch('https://allowed.example.test/after-quota'); break;
        }
        return 'unexpected success';
      });
    }
    if (mode === 'quota-sleep') {
      await step.do('prepare', async context => {
        await record('prepare', context);
        await fetch('https://allowed.example.test/gate?id=' + event.instanceId);
      });
      await step.sleep('nap', 1);
      return step.do('after-sleep', context => record('unexpected', context));
    }
    if (mode === 'worker-cache') {
      await step.do('started', context => record('started', context));
      if (event.payload.wait) await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return step.do('inspect', async () => {
        console.info('worker-cache:' + event.instanceId);
        return {
          handler: 'example', instanceId: event.instanceId, value: event.payload.value,
          workflowName: event.workflowName, connector: !!this.env.CONNECTOR,
          network: (await fetch('https://allowed.example.test/ok')).status,
        };
      });
    }
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

export class OtherWorkflow extends ExampleWorkflow {
  async run(event, step) { return { ...await super.run(event, step), handler: 'other' }; }
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
      if (request.method === 'POST') return Response.json({ id: (await env.WORKFLOW.create({ id, params: { value: Number(url.searchParams.get('value') ?? 20), mode: url.searchParams.get('mode'), wait: url.searchParams.get('wait') === 'true' } })).id });
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
  async scheduled(controller, env, ctx) {
    const runs = await env.KV.get('cron-runs', 'json') ?? [];
    ctx.waitUntil(Promise.all([
      env.KV.put('cron', controller.cron),
      env.KV.put('cron-runs', JSON.stringify([...runs, controller.scheduledTime])),
    ]));
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      ctx.waitUntil(env.KV.put('queue', message.body.value));
      message.ack();
    }
  },
};
`;

export const parentSource = `
import runtime, { RuntimeManagement as BaseManagement, CloudflareWorkflowCatalog as RuntimeWorkflowCatalog, CloudflareAppWorkflow as RuntimeAppWorkflow, WorkflowSessions as RuntimeWorkflowSessions } from './runtime.js';
import { WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
export * from './runtime.js';
${executionRecorder}
export class RuntimeManagement extends BaseManagement {
  constructor(ctx, env) { super(ctx, recordExecution(env)); }
}
const logRecords = [];
const workflowWorkers = [];
const gates = new Map();
const collectorRequests = [];
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

export class CloudflareAppWorkflow extends RuntimeAppWorkflow {
  run(event, step) {
    const record = { instanceId: event.payload.id, key: null, loads: 0 };
    workflowWorkers.push(record);
    const loader = recordExecution(this.env).WIDEFLEET_LOADER;
    return new RuntimeAppWorkflow(this.ctx, {
      ...this.env,
      WIDEFLEET_LOADER: {
        get(key, callback) {
          record.key = key;
          return loader.get(key, () => { record.loads++; return callback(); });
        },
        load(code) { record.loads++; return loader.load(code); },
      },
    }).run(event, {
      do: (...args) => step.do(...args),
      sleep: (...args) => step.sleep(...args),
      sleepUntil: (...args) => step.sleepUntil(...args),
      waitForEvent(...args) {
        const result = step.waitForEvent(...args).catch(error => {
          record.waitError = { name: error.name, message: error.message };
          throw error;
        });
        record.waiting = true;
        return result;
      },
    });
  }
}

export class CloudflareWorkflowCatalog extends RuntimeWorkflowCatalog {
  constructor(ctx, env) {
    super(ctx, {
      ...env,
      WIDEFLEET_WORKFLOWS: {
        async create(options) {
          const fault = await ctx.storage.get('creationFault');
          if (fault === 'before') throw new Error('Synthetic Workflow creation failure');
          const instance = await env.WIDEFLEET_WORKFLOWS.create(options);
          if (fault === 'after') throw new Error('Synthetic Workflow response failure');
          return instance;
        },
        async get(id) {
          if (await ctx.storage.get('creationFault') === 'lookup')
            throw new Error('Synthetic Workflow lookup failure');
          const instance = await env.WIDEFLEET_WORKFLOWS.get(id);
          if (await ctx.storage.get('creationFault') === 'slow-pause') return {
            status: () => instance.status(),
            pause: async () => {
              await ctx.storage.put('pauseStarted', true);
              await new Promise(resolve => setTimeout(resolve, 30_000));
            },
          };
          if (await ctx.storage.get('creationFault') === 'pause') return {
            status: () => instance.status(),
            pause: async () => { throw new Error('Synthetic pause failure'); },
          };
          return instance;
        },
      },
      AUTH_CONFIG: {
        async get(key, ...args) {
          if (key.endsWith('/http-availability')) {
            const mode = await ctx.storage.get('admissionFault');
            if (mode) {
              const reads = (await ctx.storage.get('admissionReads') ?? 0) + 1;
              await ctx.storage.put('admissionReads', reads);
              if (reads > 1 && mode === 'blocked') return JSON.stringify({ blocked: true });
              if (reads > 1 && mode === 'error') throw new Error('Synthetic admission read failure');
            }
          }
          return env.AUTH_CONFIG.get(key, ...args);
        },
      },
    });
  }
  async admissionFault(mode) {
    await this.ctx.storage.put('admissionFault', mode);
    await this.ctx.storage.put('admissionReads', 0);
  }
  async admissionReads() { return await this.ctx.storage.get('admissionReads') ?? 0; }
  async creationFault(mode) { await this.ctx.storage.put('creationFault', mode); }
  async runReconciliation() { await super.alarm(); }
  async reconciliationProgress() {
    return { progress: await this.ctx.storage.get('pauseReconciliation') ?? null,
      alarm: await this.ctx.storage.getAlarm(), pauseStarted: await this.ctx.storage.get('pauseStarted') ?? false };
  }
  async nativeEvent(scope, id) {
    const record = await this.ctx.storage.get('instance/' + scope.workflow + '/' + id);
    await (await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId)).sendEvent({ type: 'continue', payload: { add: 21 } });
  }
  async nativeExists(scope, id) {
    const record = await this.ctx.storage.get('instance/' + scope.workflow + '/' + id);
    if (!record) return false;
    try {
      await this.env.WIDEFLEET_WORKFLOWS.get(record.nativeId);
      return true;
    } catch (error) {
      if (/not.found|does not exist/i.test(error.message)) return false;
      throw error;
    }
  }
  async forgetStart(scope, id) {
    const key = 'instance/' + scope.workflow + '/' + id;
    const record = await this.ctx.storage.get(key);
    if (!record) throw new Error('Missing fixture Workflow record');
    await this.ctx.storage.put(key, { ...record, started: false });
  }
  async seedPending(scope, id) {
    const app = await (await this.env.WIDEFLEET_PACKAGES.get('hosts/' + scope.hostname + '.json')).json();
    await this.ctx.storage.put('instance/' + scope.workflow + '/' + id, {
      id, nativeId: crypto.randomUUID(), createdAt: new Date().toISOString(),
      creation: {}, started: false,
      start: { ...scope, id, version: app.version, params: { mode: 'sleep' } },
    });
  }
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
  if (url.origin === 'https://collector.example.test') {
    collectorRequests.push({ url: request.url, authorization: request.headers.get('authorization'), body: await request.text() });
    return new Response(null, { status: 204 });
  }
  if (url.origin !== 'https://allowed.example.test') throw new Error('Unapproved fixture transport');
  if (request.redirect !== 'manual') throw new Error('Gateway followed redirects in the parent');
  if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://denied.example.test/private' } });
  if (url.pathname === '/gate') {
    const id = url.searchParams.get('id');
    gates.set(id, true);
    while (gates.has(id)) await new Promise(resolve => setTimeout(resolve, 25));
  }
  return new Response('allowed fixture');
};

export default {
  ...runtime,
  async fetch(request, env, ctx) {
    env = recordExecution(env);
    const executionPolicy = request.headers.get('x-fixture-execution-policy');
    if (executionPolicy !== null) env.WIDEFLEET_EXECUTION_LIMITS = executionPolicy;
    const url = new URL(request.url);
    url.protocol = "https:";
    url.port = "";
    request = new Request(url, request);
    if (request.headers.get('x-fixture-management') === 'true') {
      request.headers.delete('x-fixture-management');
      return env.RUNTIME_MANAGEMENT.fetch(request);
    }
    if (url.pathname === '/fixture/logs') return Response.json(logRecords);
    if (url.pathname === '/fixture/executions') return Response.json(executions.splice(0));
    if (url.pathname === '/fixture/workflow-workers') return Response.json(workflowWorkers);
    if (url.pathname === '/fixture/gates') {
      if (request.method === 'POST') {
        const id = url.searchParams.get('id');
        gates.delete(id);
      }
      return Response.json([...gates.keys()]);
    }
    if (url.pathname === '/fixture/attempts') return Response.json((await env.DB.prepare('SELECT label, attempt FROM workflow_attempts WHERE id = ? ORDER BY rowid').bind(url.searchParams.get('id')).all()).results);
    if (url.pathname === '/fixture/collector-requests') return Response.json(collectorRequests);
    if (url.pathname === '/fixture/workflow-session') {
      let loads = 0;
      const loader = env.WIDEFLEET_LOADER;
      const sessions = new RuntimeWorkflowSessions(ctx, {
        ...env,
        WIDEFLEET_LOADER: {
          ...loader,
          load(code) { loads++; return loader.load(code); },
        },
      });
      try {
        const session = await sessions.open(await request.json());
        session.close();
        return Response.json({ loads });
      } catch (error) { return Response.json({ loads, error: error.message }); }
    }
    if (url.pathname === '/fixture/workflow-binding') {
      const { scope, method, id, options, action } = await request.json();
      try {
        if (['seedPending', 'forgetStart', 'admissionFault', 'admissionReads', 'creationFault', 'nativeExists', 'nativeEvent', 'reconcile', 'reconciliationProgress'].includes(method)) {
          const catalog = env.WIDEFLEET_WORKFLOW_CATALOG.get(env.WIDEFLEET_WORKFLOW_CATALOG.idFromName(scope.appId));
          if (method === 'seedPending') await catalog.seedPending(scope, id);
          if (method === 'forgetStart') await catalog.forgetStart(scope, id);
          if (method === 'admissionFault') await catalog.admissionFault(options);
          if (method === 'admissionReads') return Response.json(await catalog.admissionReads());
          if (method === 'creationFault') await catalog.creationFault(options);
          if (method === 'nativeExists') return Response.json(await catalog.nativeExists(scope, id));
          if (method === 'nativeEvent') await catalog.nativeEvent(scope, id);
          if (method === 'reconcile') await catalog.runReconciliation();
          if (method === 'reconciliationProgress') return Response.json(await catalog.reconciliationProgress());
          return Response.json({ ok: true });
        }
        const binding = ctx.exports.WorkflowBinding({ props: scope });
        const result = method === 'create' ? await binding.create(options)
          : method === 'createBatch' ? await binding.createBatch(options)
          : method === 'get' ? await binding.get(id)
          : await binding.instance(id, action, options);
        return Response.json(result);
      } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
    }
    if (url.pathname === '/fixture/reconcile-workflows') {
      const { organizationId, appIds } = await request.json();
      await env.RUNTIME_MANAGEMENT.reconcileWorkflows(organizationId, appIds);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/fixture/availability') {
      const { organizationId = 'widefleet', value } = await request.json();
      const key = 'organizations/' + organizationId + '/http-availability';
      if (value === null) await env.AUTH_CONFIG.delete(key);
      else await env.AUTH_CONFIG.put(key, value);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/fixture/auth-route') {
      const { hostname, value } = await request.json();
      if (value === null) await env.AUTH_CONFIG.delete('apps/' + hostname);
      else await env.AUTH_CONFIG.put('apps/' + hostname, value);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/fixture/scheduled') {
      const { time, mode, reset } = await request.json();
      if (reset) await Promise.all([env.KV.delete('cron-runs'), env.PREVIEW_KV.delete('cron-runs')]);
      let error = null;
      try {
        await runtime.scheduled({cron:'* * * * *',scheduledTime:time}, {
          ...env,
          WIDEFLEET_HTTP_AVAILABILITY: mode === 'disabled' ? '' : env.WIDEFLEET_HTTP_AVAILABILITY,
          AUTH_CONFIG: {
            get(key, ...args) {
              if (mode === 'disabled'
                || (mode === 'status-error' && key === 'organizations/widefleet/http-availability')
                || (mode === 'route-error' && key === 'apps/app.example.test'))
                throw new Error('Synthetic cron KV failure');
              return env.AUTH_CONFIG.get(key, ...args);
            },
          },
        }, ctx);
      } catch (cause) { error = cause.message; }
      return Response.json({error, runs: await Promise.all([
        env.KV.get('cron-runs', 'json'), env.PREVIEW_KV.get('cron-runs', 'json'),
      ])});
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
