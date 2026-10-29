import { WorkerEntrypoint } from "cloudflare:workers";
import { withAppCaller } from "./app-context.ts";
import { z } from "zod";
import type { AppValue } from "./app-rpc.ts";

type Properties = { appCaller?: string };

type Environment = Record<string, AppValue>;

type Entrypoint = {
  new (ctx: ExecutionContext, env: Environment): WorkerEntrypoint<Environment, Properties>;
  readonly prototype: WorkerEntrypoint<Environment, Properties>;
};

type Handler = ExportedHandler<Environment, AppValue, unknown, Properties>;

type Method = (...args: AppValue[]) => AppValue | Promise<AppValue>;

const callable = z.custom<Method>((value) => z.function().safeParse(value).success);

const entrypoint = z.custom<Entrypoint>((value) => z.function().safeParse(value).success);

// The generated bootstrap calls this for the default handler and every published
// RPC entrypoint. AsyncLocalStorage keeps the delegation local to each invocation,
// including concurrent requests and calls made after an await.
export const callerEntrypoint = (application: Entrypoint | Handler) => {
  const constructor = entrypoint.safeParse(application);

  if (!constructor.success) {
    const scoped = { ...application };

    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(application),
    )) {
      const parsed = callable.safeParse(descriptor.value);

      if (!parsed.success) continue;
      const method = parsed.data;

      // Preserve native RPC's rejection of object methods with invalid arity.
      if (name !== "fetch" && method.length > 3) continue;
      Object.defineProperty(scoped, name, {
        ...descriptor,
        value(arg: AppValue, env: Environment, ctx: ExecutionContext<Properties>) {
          return withAppCaller(ctx.props.appCaller, () => method.call(application, arg, env, ctx));
        },
      });
    }

    return scoped;
  }

  // Functions other than WorkerEntrypoint classes are legal module exports.
  // Preserve their native classification instead of trying to subclass them.
  if (!(constructor.data.prototype instanceof WorkerEntrypoint)) return application;

  const contexts = new WeakMap<object, ExecutionContext<Properties>>();

  class ScopedEntrypoint extends constructor.data {
    constructor(ctx: ExecutionContext<Properties>, env: Environment) {
      super(ctx, env);
      contexts.set(this, ctx);
    }
  }

  const seen = new Set(["constructor"]);

  // Override only prototype methods, preserving native RPC's exclusion of
  // instance fields and getters and the original receiver's private fields.
  for (
    let prototype: object | null = constructor.data.prototype;
    prototype && prototype !== WorkerEntrypoint.prototype;
    // SAFETY: ECMAScript prototypes are objects or null; no app value is coerced.
    prototype = Object.getPrototypeOf(prototype) as object | null
  )
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);

      const parsed = callable.safeParse(descriptor?.value);

      if (!parsed.success) continue;
      const method = parsed.data;
      Object.defineProperty(ScopedEntrypoint.prototype, name, {
        ...descriptor,
        value(this: WorkerEntrypoint<Environment, Properties>, ...args: AppValue[]) {
          return withAppCaller(contexts.get(this)?.props.appCaller, () => method.apply(this, args));
        },
      });
    }

  return ScopedEntrypoint;
};
