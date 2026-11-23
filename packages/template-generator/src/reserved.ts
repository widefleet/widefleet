import { appRpcMethod } from "@platform/contracts";

// Names Widefleet, Workers RPC or the templates' own methods use, which a
// generated method must not take.
export const reservedMethods = [
  "approvalLevel",
  "connectionStatus",
  "constructor",
  "dup",
  "fetch",
  "setApprovalLevel",
  "then",
  "toString",
  "valueOf",
  "withInput",
];

/**
 * Whether a generated method may not take a name: Widefleet refuses it as an app
 * method, or Workers RPC or the templates' own methods use it.
 */
export const reservedMethod = (name: string) =>
  reservedMethods.includes(name) || !appRpcMethod.safeParse(name).success;
