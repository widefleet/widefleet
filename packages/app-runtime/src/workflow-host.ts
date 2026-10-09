import {
  RpcTarget,
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { readApp } from "./catalog.ts";
import { workerCode } from "./worker.ts";
import type { ParentEnvironment } from "./types.ts";
import type { WorkflowRunner } from "./workflow-runner.ts";
import {
  fault,
  restore,
  type Start,
  type AppEvent,
  type Reply,
  type ReplayCommand,
  type StepContext,
} from "./workflow-protocol.ts";

class Session extends RpcTarget {
  #worker;
  #runner;
  constructor(worker: WorkerStub) {
    super();
    this.#worker = worker;
    this.#runner = worker.getEntrypoint<WorkflowRunner>("WorkflowRunner");
  }
  begin(event: AppEvent) {
    return this.#runner.begin(event);
  }
  async advance(results: Reply[], replay?: ReplayCommand[]) {
    const turn = await this.#runner.advance(results, replay);

    return { commands: [...turn.commands], active: turn.active };
  }
  next() {
    return this.#runner.next();
  }
  async execute(id: string, context: StepContext) {
    const result = await this.#runner.execute(id, context);

    return result.error ? { error: result.error } : { value: result.value };
  }
  close() {
    this.#worker.dispose();
  }
  [Symbol.dispose]() {
    this.close();
  }
}

export class WorkflowSessions extends WorkerEntrypoint<ParentEnvironment> {
  async open(start: Start) {
    const current = await readApp(this.env, `hosts/${start.hostname}.json`);
    const pinned = await readApp(this.env, `versions/${start.appId}/${start.version}.json`);

    if (!current || current.appId !== start.appId || !pinned || pinned.appId !== start.appId)
      throw new Error("Workflow app is no longer published");

    const app = {
      ...pinned,
      network: current.network,
      telemetry: current.telemetry,
      capabilities: Object.fromEntries(
        Object.entries(pinned.capabilities).filter(
          ([name, native]) => current.capabilities[name] === native,
        ),
      ),
    };

    // A fresh isolate per replay keeps app globals and callbacks instance-local.
    return new Session(
      this.env.WIDEFLEET_LOADER.load(await workerCode(app, this.env, this.ctx, start.workflow)),
    );
  }
}

export class AppWorkflow extends WorkflowEntrypoint<ParentEnvironment, Start> {
  override async run(event: WorkflowEvent<Start>, step: WorkflowStep) {
    const start = event.payload;
    let runner: Rpc.Stub<Session> | undefined;
    let synchronized = 0;
    const history: { results: Reply[]; commands: ReplayCommand[] }[] = [];
    let synchronization = Promise.resolve();

    const ensure = async () => {
      synchronization = synchronization.then(async () => {
        if (!runner) {
          runner = await this.env.WIDEFLEET_WORKFLOW_SESSIONS.open(start);
          await runner.begin({
            payload: start.params,
            timestamp: event.timestamp,
            instanceId: start.id,
            workflowName: start.workflow,
          });
        }

        while (synchronized < history.length) {
          const turn = history[synchronized++];

          if (turn) await runner.advance(turn.results, turn.commands);
        }
      });
      await synchronization;

      if (!runner) throw new Error("Workflow session is unavailable");

      return runner;
    };

    let notification: Promise<null> | undefined;
    let ordinal = 0;
    let commandOrdinal = 0;
    const pending = new Map<string, Promise<Reply>>();

    const advance = async (reply: Reply | null, listen = false) => {
      // A native step keeps the engine active during RPC. Persist the selected
      // result's identity: completion order can change when parallel steps replay.
      const turn = await step.do(
        `bridge/${ordinal++}`,
        { timeout: 60000, retries: { limit: 0, delay: 0 } },
        async () => {
          const target = await ensure();

          const selected = listen
            ? await Promise.race([
                ...pending.values(),
                (notification ??= target.next().then(() => {
                  notification = undefined;

                  return null;
                })),
              ])
            : reply;

          const turn = await target.advance(selected === null ? [] : [selected]);
          synchronized = history.length + 1;

          return {
            replyId: selected?.id ?? null,
            commands: [...turn.commands],
            active: turn.active,
          };
        },
      );

      const results: Reply[] = [];

      if (turn.replyId !== null) {
        const result = await pending.get(turn.replyId);

        if (!result) throw new Error("Missing recorded step result");
        results.push(result);
        pending.delete(turn.replyId);
      }

      history.push({
        results,
        commands: turn.commands.map((command) =>
          "id" in command ? { kind: command.kind, id: command.id } : { kind: command.kind },
        ),
      });

      return turn;
    };

    try {
      let turn = await advance(null);

      for (;;) {
        for (const command of turn.commands) {
          if (command.kind === "complete") return command.value;

          if (command.kind === "error") throw restore(command.error);
          // The checkpoint fixes this order. Keep native names short regardless
          // of the length or encoding of the app's logical step names.
          const name = `app/${++commandOrdinal}`;

          const execute = async () => {
            switch (command.kind) {
              case "do":
                return step.do(name, command.config, async (context) => {
                  const result = await (
                    await ensure()
                  ).execute(command.id, {
                    ...context,
                    step: { name: command.name, count: command.count },
                  });

                  if (result.error) throw restore(result.error);

                  return result.value;
                });
              case "sleep":
                await step.sleep(name, command.duration);

                return undefined;
              case "sleepUntil":
                await step.sleepUntil(name, command.deadline);

                return undefined;
              case "waitForEvent":
                return step.waitForEvent(name, command.options);
              default:
                throw new Error("Invalid Workflow command");
            }
          };

          pending.set(
            command.id,
            Promise.resolve()
              .then(execute)
              .then(
                (value) => ({ id: command.id, value }),
                (cause: unknown) => ({ id: command.id, error: fault(cause) }),
              ),
          );
        }

        if (turn.active) turn = await advance(null, true);
        else {
          if (pending.size === 0) throw new Error("Workflow did not complete or schedule a step");
          turn = await advance(await Promise.race(pending.values()));
        }
      }
    } finally {
      await runner?.close();
    }
  }
}
