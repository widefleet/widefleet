import { WorkerEntrypoint } from "cloudflare:workers";
import app from "widefleet:app";
import type { QueueInput, ScheduledInput, Settlement } from "./types.ts";

const background = (context: ExecutionContext) => {
  const pending: Promise<void>[] = [];
  let failure: string | null = null;

  const record = (cause: unknown) => {
    console.error(cause);
    failure ??= String(cause);
  };

  const ctx = {
    waitUntil(promise: Promise<void>) {
      pending.push(Promise.resolve(promise).catch(record));
    },
    passThroughOnException() {
      throw new Error("passThroughOnException is unavailable for background events");
    },
    props: context.props,
    exports: context.exports,
    tracing: context.tracing,
    abort(reason?: Error) {
      context.abort(reason);
    },
  };

  return {
    ctx,
    record,
    async finish() {
      while (pending.length) await Promise.all(pending.splice(0));

      return failure;
    },
  };
};

export class Events extends WorkerEntrypoint {
  ready() {
    // Resolving this entrypoint evaluates the app module without invoking a handler.
    return true;
  }

  async runScheduled(input: ScheduledInput) {
    let noRetry = false;
    const work = background(this.ctx);

    try {
      if (!app.scheduled) throw new Error("The app has no scheduled handler");
      await app.scheduled(
        {
          ...input,
          noRetry() {
            noRetry = true;
          },
        },
        this.env,
        work.ctx,
      );
    } catch (cause) {
      work.record(cause);
    }

    return { noRetry, error: await work.finish() };
  }
  async runQueue(input: QueueInput) {
    const decisions = new Map<string, Settlement>();

    const settle = (decision: Settlement) => {
      if (!decisions.has(decision.id)) decisions.set(decision.id, decision);
    };

    const messages = input.messages.map((message) => ({
      ...message,
      ack() {
        settle({ id: message.id, action: "ack" });
      },
      retry(options?: QueueRetryOptions) {
        const decision: Settlement = { id: message.id, action: "retry" };

        if (options !== undefined) decision.options = options;
        settle(decision);
      },
    }));

    const work = background(this.ctx);

    try {
      if (!app.queue) throw new Error("The app has no queue handler");
      await app.queue(
        {
          queue: input.queue,
          messages,
          metadata: input.metadata,
          ackAll() {
            for (const message of messages) message.ack();
          },
          retryAll(options?: QueueRetryOptions) {
            for (const message of messages) message.retry(options);
          },
        },
        this.env,
        work.ctx,
      );
    } catch (cause) {
      work.record(cause);
    }

    return { decisions: [...decisions.values()], error: await work.finish() };
  }
}
