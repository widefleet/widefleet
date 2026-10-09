import { AsyncLocalStorage } from "node:async_hooks";

export const insideStep = new AsyncLocalStorage<boolean>();

// Keep the host listening while non-durable work can produce more commands.
// Native step callbacks already have their own durable execution frame.
const schedule = globalThis.setTimeout;

const cancel = globalThis.clearTimeout;

const tasks = new Set<symbol>();

const timers = new Map<unknown, () => void>();

let notify = () => {};

let keepAlive = (_operation: Promise<void>) => {};

const start = () => {
  const task = Symbol();
  tasks.add(task);
  let complete = () => {};

  // The originating RPC must retain its I/O after returning a command batch.
  keepAlive(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );

  return () => {
    tasks.delete(task);
    complete();
    notify();
  };
};

const track = async <T>(operation: Promise<T>) => {
  if (insideStep.getStore()) return operation;
  const finish = start();

  try {
    return await operation;
  } finally {
    finish();
  }
};

const responseActivity = (response: Response) => {
  const arrayBuffer = response.arrayBuffer.bind(response);
  const blob = response.blob.bind(response);
  const formData = response.formData.bind(response);
  const json = response.json.bind(response);
  const text = response.text.bind(response);
  const clone = response.clone.bind(response);

  return Object.assign(response, {
    arrayBuffer: () => track(arrayBuffer()),
    blob: () => track(blob()),
    formData: () => track(formData()),
    json: () => track(json()),
    text: () => track(text()),
    clone: () => responseActivity(clone()),
  });
};

export const activity = {
  pending: () => tasks.size > 0,
  settle: () => new Promise<void>((resolve) => schedule(resolve, 0)),
  deadline: (callback: () => void) => {
    const timer = schedule(callback, 60000);

    return () => cancel(timer);
  },
  observe: (listener: () => void) => {
    notify = listener;
  },
  install: (register: (operation: Promise<void>) => void) => {
    keepAlive = register;
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      insideStep.getStore() ? fetch(input, init) : track(fetch(input, init).then(responseActivity));
    globalThis.setTimeout = Object.assign(
      (handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (insideStep.getStore()) return schedule(handler, delay, ...args);
        const finish = start();

        const timer = schedule(() => {
          timers.delete(timer);

          try {
            handler(...args);
          } finally {
            finish();
          }
        }, delay);

        timers.set(timer, finish);

        return timer;
      },
      schedule,
    );
    globalThis.clearTimeout = (timer) => {
      if (timer !== undefined) {
        timers.get(timer)?.();
        timers.delete(timer);
      }

      if (timer !== null) cancel(timer);
    };
  },
};
