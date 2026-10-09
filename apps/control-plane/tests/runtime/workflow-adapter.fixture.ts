// Synthetic application exercising the standard Cloudflare Workflow API.
// Native celld owns step results, retries, deadlines and instance lifecycle.

export const applicationSource = String.raw`import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

export class AppWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { mode, id } = event.payload;
    const record = async (label, value) => {
      await this.env.OBSERVE.record(id, label);
      return value;
    };
    if (mode === 'output') return step.do('output', async () => ({ integer: 42n, map: new Map([['key', 7]]) }));
    if (mode === 'resources') {
      await step.do('persist', async () => {
        await this.env.DB.exec('CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY)');
        await this.env.DB.prepare('INSERT INTO records VALUES (?)').bind(id).run();
        await this.env.KV.put(id, 'saved');
        await this.env.FILES.put(id, 'saved');
      });
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return step.do('read', async () => ({
        row: await this.env.DB.prepare('SELECT id FROM records WHERE id = ?').bind(id).first('id'),
        kv: await this.env.KV.get(id), file: await (await this.env.FILES.get(id)).text(),
      }));
    }
    if (mode === 'permissions') {
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return step.do('inspect', async () => ({ connector: !!this.env.OBSERVE, secret: this.env.PLATFORM_SECRET ?? null }));
    }
    if (mode === 'sequential') {
      const a = await step.do('first', () => record('first', 20));
      const next = await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return step.do('finish', () => record('finish', (a + next.payload.add) * 2));
    }
    if (mode === 'sleep') {
      const a = await step.do('first', () => record('first', 20));
      await step.sleep('nap', 100);
      const deadline = await step.do('deadline', async () => new Date(Date.now() + 1000));
      await step.sleepUntil('until', deadline);
      return step.do('finish', () => record('finish', a * 2));
    }
    if (mode === 'custom-error') {
      return step.do('custom-error', { retries: { limit: 2, delay: 50 } }, async () => {
        await record('custom-error', null);
        throw new NonRetryableError('permanent custom error', 'ApplicationFailure');
      });
    }
    if (mode === 'nested') {
      return step.do('outer', async () => step.do('inner', async () => 'invalid'));
    }
    if (mode === 'retry') {
      return step.do('retry', { retries: { limit: 2, delay: 100 } }, async ctx => {
        await record('attempt-' + ctx.attempt, null);
        if (ctx.attempt < 3) throw new Error('retry fixture');
        return ctx.attempt;
      });
    }
    if (mode === 'catch') {
      try {
        await step.do('failure', { retries: { limit: 2, delay: 100 } }, async () => {
          await record('failure', null);
          throw new NonRetryableError('permanent fixture');
        });
      } catch (error) {
        await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
        return step.do('recover', () => ({ name: error.name, message: error.message }));
      }
    }
    if (mode === 'parallel') {
      const values = await Promise.all([1, 2, 3].map(value => step.do('same-name', () => record('value-' + value, value))));
      return values.reduce((sum, value) => sum + value, 0);
    }
    if (mode === 'mixed') {
      return Promise.all([
        step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' }),
        (async () => {
          const a = await step.do('first', () => record('first', 20));
          return step.do('second', () => record('second', a + 1));
        })(),
      ]);
    }
    if (mode === 'before-first') {
      await new Promise(resolve => setTimeout(resolve, 50));
      await (await fetch(event.payload.url)).text();
      const canceled = setTimeout(() => { throw new Error('Canceled timer ran'); }, 5000);
      clearTimeout(canceled);
      const result = await step.do('first', () => record('first', 23));
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return result;
    }
    if (mode === 'reordered-fetch' || mode === 'reordered-timer') {
      const values = await Promise.all(['left', 'right'].map(async (branch, index) => {
        const response = await fetch(event.payload.url + '?' + new URLSearchParams({ id, branch, mode }));
        const { delay } = await response.json();
        if (mode === 'reordered-timer') await new Promise(resolve => setTimeout(resolve, delay));
        const first = await step.do(branch, () => record(branch, (index + 1) * 10));
        return step.do(branch + '-next', () => record(branch + '-next', first + 1));
      }));
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return step.do('finish', () => record('finish', values));
    }
    if (mode === 'delayed-timer' || mode === 'delayed-fetch') {
      const result = await Promise.all([
        step.waitForEvent('signal', { type: 'signal', timeout: '10 seconds' }),
        (async () => {
          const first = await step.do('first', () => record('first', 20));
          if (mode === 'delayed-timer') await new Promise(resolve => setTimeout(resolve, 150));
          else await (await fetch(event.payload.url)).json();
          return step.do('signal', async () => {
            const instance = await this.env.WORKFLOW.get(event.instanceId);
            await instance.sendEvent({ type: 'signal', payload: { ready: true } });
            return record('signal', first + 1);
          });
        })(),
        step.do('concurrent', async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 22;
        }),
      ]);
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return result;
    }
    if (mode === 'loop') {
      let sum = 0;
      for (let i = 0; i < 3; i++) sum += await step.do('same-name', () => record('loop-' + i, i));
      return sum;
    }
    if (mode === 'context') {
      return Promise.all(['__bridge_turn_0', '__bridge_turn_0', ''].map(name => step.do(name, ctx => ctx.step)));
    }
    if (mode === 'values') {
      const value = await step.do('values', async () => {
        await record('values', null);
        return { date: new Date('2026-01-01T00:00:00Z'), bytes: new Uint8Array([3, 5]), map: new Map([['key', 7]]) };
      });
      await step.waitForEvent('continue', { type: 'continue', timeout: '5 minutes' });
      return { date: value.date.toISOString(), bytes: Array.from(value.bytes), map: value.map.get('key') };
    }
    if (mode === 'denied') {
      return step.do('denied', { retries: { limit: 0, delay: 0 } }, async () => {
        try { const response = await fetch(event.payload.url); return { status: response.status, secret: this.env.PLATFORM_SECRET ?? null }; }
        catch (error) { return { error: error.message, secret: this.env.PLATFORM_SECRET ?? null }; }
      });
    }
    if (mode === 'timeout') {
      return step.do('timeout', { timeout: 20, retries: { limit: 0, delay: 0 } }, async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'late';
      });
    }
    throw new Error('Unknown mode');
  }
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (url.pathname === '/batch') {
    const options = [id + '-a', id + '-b', id + '-a'].map(id => ({ id, params: { id, mode: 'loop' }, locationHint: 'weur', retention: { successRetention: '1 day' } }));
    options.push({ id: id + '-uncloneable', params: { callback() {} } });
    return Response.json({ ids: (await env.WORKFLOW.createBatch(options)).map(instance => instance.id) });
  }
  if (url.pathname === '/deleteBatch') return Response.json(await env.WORKFLOW.deleteBatch([id + '-a', id + '-a', id + '-b', id + '-missing']));
  if (url.pathname === '/create') {
    return Response.json({ id: (await env.WORKFLOW.create({ id, params: { mode: url.searchParams.get('mode'), id, url: url.searchParams.get('url') }, ...(url.searchParams.has('expire') ? { retention: { successRetention: 1 } } : {}) })).id });
  }
  const instance = await env.WORKFLOW.get(id);
  if (url.pathname === '/status') return Response.json(await instance.status());
  if (url.pathname === '/continue') { await instance.sendEvent({ type: 'continue', payload: { add: 1 } }); return Response.json({ ok: true }); }
  if (url.pathname === '/pause') { await instance.pause(); return Response.json({ ok: true }); }
  if (url.pathname === '/resume') { await instance.resume(); return Response.json({ ok: true }); }
  if (url.pathname === '/terminate') { await instance.terminate(); return Response.json({ ok: true }); }
  if (url.pathname === '/restart') { await instance.restart(); return Response.json({ ok: true }); }
  if (url.pathname === '/delete') { await instance.delete(); return Response.json({ ok: true }); }
  return new Response('not found', { status: 404 });
} };
`;
