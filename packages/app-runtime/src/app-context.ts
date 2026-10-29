import { AsyncLocalStorage } from "node:async_hooks";

const invocation = new AsyncLocalStorage<string | undefined>();

export const currentAppCaller = () => invocation.getStore();

export const withAppCaller = <T>(proof: string | undefined, operation: () => T) =>
  invocation.run(proof, operation);
