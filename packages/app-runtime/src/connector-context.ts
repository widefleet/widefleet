import { AsyncLocalStorage } from "node:async_hooks";

const invocation = new AsyncLocalStorage<string | undefined>();

export const currentConnectorCaller = () => invocation.getStore();

export const withConnectorCaller = <T>(proof: string | undefined, operation: () => T) =>
  invocation.run(proof, operation);
