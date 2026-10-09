import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowSleepDuration,
  type WorkflowTimeoutDuration,
  type WorkflowStepRollbackOptions,
} from "cloudflare:workers";
import { activity, insideStep } from "./workflow-activity.ts";
import ApplicationWorkflow from "widefleet:workflow";
import {
  fault,
  restore,
  type WorkflowValue,
  type AppEvent,
  type Command,
  type Reply,
  type ReplayCommand,
  type StepConfig,
  type StepContext,
} from "./workflow-protocol.ts";

const stepConfiguration = z.strictObject({
  retries: z
    .strictObject({
      limit: z.number().int().min(0).max(10000),
      delay: z.union([
        z.number().nonnegative(),
        z.custom<import("cloudflare:workers").WorkflowDelayDuration>(
          (value) => z.string().safeParse(value).success,
        ),
      ]),
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
  timeout: z
    .union([
      z.number().nonnegative(),
      z.custom<WorkflowTimeoutDuration>((value) => z.string().safeParse(value).success),
    ])
    .optional(),
  sensitive: z.literal("output").optional(),
});

type Callback = (context: StepContext) => Promise<WorkflowValue>;

const callbacks = new Map<string, Callback>();

const pending = new Map<
  string,
  { resolve: (value: WorkflowValue) => void; reject: (error: Error) => void }
>();

const commands: Command[] = [];

const counts = new Map<string, number>();

let started = false;

const waiters = new Set<() => void>();

const notify = () => {
  for (const resolve of waiters) resolve();
};

const changed = () =>
  new Promise<void>((resolve) => {
    const complete = () => {
      waiters.delete(complete);
      resolve();
    };

    waiters.add(complete);
  });

const delivering = async <T>(operation: () => Promise<T>) => {
  // Retain one request-owned deadline across notifications from other RPCs.
  let clear = () => {};

  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        clear = activity.deadline(() => reject(new Error("Workflow command delivery timed out")));
      }),
      operation(),
    ]);
  } finally {
    clear();
  }
};

activity.observe(() => notify());

const operation = (command: Command) => {
  if (insideStep.getStore()) throw new NonRetryableError("Workflow steps cannot be nested");

  if (!("id" in command)) throw new Error("Expected step command");

  const promise = new Promise<WorkflowValue>((resolve, reject) =>
    pending.set(command.id, { resolve, reject }),
  );

  commands.push(command);
  notify();

  return promise;
};

const identity = (name: string) => {
  z.string()
    .max(256)
    .refine((value) => !Array.from(value).some((character) => character.charCodeAt(0) < 32))
    .parse(name);
  const count = (counts.get(name) ?? 0) + 1;
  counts.set(name, count);

  // Parallel branches can register different names in a different order on replay.
  return { id: JSON.stringify([name, count]), name, count };
};

export const workflowSteps = {
  do(
    name: string,
    config: StepConfig | Callback,
    callback?: Callback,
    rollback?: WorkflowStepRollbackOptions<WorkflowValue>,
  ) {
    const functionConfig = z
      .function({ input: [z.custom<StepContext>()], output: z.promise(z.custom<WorkflowValue>()) })
      .safeParse(config);

    if (rollback !== undefined || (functionConfig.success && callback !== undefined))
      throw new Error("Workflow rollback is not supported by celld");
    const invoke = functionConfig.success ? functionConfig.data : callback;

    if (!invoke) throw new Error("A step callback is required");
    const options: StepConfig = {};

    if (!functionConfig.success) {
      const parsed = stepConfiguration.parse(config);

      if (parsed.timeout !== undefined) options.timeout = parsed.timeout;

      if (parsed.sensitive !== undefined) options.sensitive = parsed.sensitive;

      if (parsed.retries) {
        options.retries = { limit: parsed.retries.limit, delay: parsed.retries.delay };

        if (parsed.retries.backoff) options.retries.backoff = parsed.retries.backoff;
      }
    }

    const entry = identity(name);
    callbacks.set(entry.id, invoke);

    return operation({ kind: "do", ...entry, config: options });
  },
  sleep(name: string, duration: number | WorkflowSleepDuration) {
    return operation({ kind: "sleep", ...identity(name), duration });
  },
  sleepUntil(name: string, deadline: Date | number) {
    return operation({ kind: "sleepUntil", ...identity(name), deadline });
  },
  waitForEvent(
    name: string,
    options: { type: string; timeout?: number | WorkflowTimeoutDuration },
  ) {
    return operation({ kind: "waitForEvent", ...identity(name), options });
  },
};

export class WorkflowRunner extends WorkerEntrypoint<Record<string, WorkflowValue>> {
  ready() {
    if (!(ApplicationWorkflow.prototype instanceof WorkflowEntrypoint))
      throw new Error("Workflow classes must extend WorkflowEntrypoint");

    return true;
  }
  begin(event: AppEvent) {
    this.ready();

    if (started) throw new Error("Workflow session already started");
    started = true;
    activity.install((operation) => this.ctx.waitUntil(operation));
    void Promise.resolve()
      .then(() => new ApplicationWorkflow(this.ctx, this.env).run(event, workflowSteps))
      .then(
        (value) => {
          commands.push({ kind: "complete", value });
          notify();
        },
        (cause: unknown) => {
          commands.push({ kind: "error", error: fault(cause) });
          notify();
        },
      );

    return true;
  }
  advance(results: Reply[], replay?: ReplayCommand[]) {
    return delivering(async () => {
      for (const result of results) {
        const entry = pending.get(result.id);

        if (!entry) throw new Error("Unknown step result");
        pending.delete(result.id);
        callbacks.delete(result.id);

        if (result.error) entry.reject(restore(result.error));
        else entry.resolve(result.value);
      }

      await activity.settle();

      if (replay) {
        const recorded: Command[] = [];

        // Hold early commands for their recorded turn, and wait for the exact
        // identities in this turn rather than taking the next N arrivals.
        for (const expected of replay) {
          let index;

          while (
            (index = commands.findIndex((command) =>
              "id" in command ? command.id === expected.id : command.kind === expected.kind,
            )) === -1
          ) {
            if (commands.some((command) => command.kind === "complete" || command.kind === "error"))
              throw new NonRetryableError("Workflow replay command mismatch");
            await changed();
          }

          const [command] = commands.splice(index, 1);

          if (!command || command.kind !== expected.kind)
            throw new NonRetryableError("Workflow replay command mismatch");
          recorded.push(command);
        }

        return { commands: recorded, active: activity.pending() };
      }

      while (commands.length === 0 && pending.size === 0) await changed();

      return { commands: commands.splice(0), active: activity.pending() };
    });
  }
  next() {
    return delivering(async () => {
      if (commands.length === 0 && activity.pending()) await changed();

      return true;
    });
  }
  async execute(id: string, context: StepContext) {
    const callback = callbacks.get(id);

    if (!callback) throw new Error("Missing step callback");

    try {
      return { value: await insideStep.run(true, () => callback(context)) };
    } catch (cause) {
      return { error: fault(cause) };
    }
  }
}
