import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";
import { fault, type Fault, type WorkflowValue } from "./workflow-protocol.ts";

export type WorkflowResult = { value?: WorkflowValue; error?: Fault; native?: boolean };

// Engine control signals (pause, restart, termination) must return unchanged.
// They are not application failures and must not acquire our fault envelope.
export class NativeWorkflowError extends Error {
  readonly fault;
  constructor(error: Fault) {
    super(error.message);
    this.name = error.name;
    this.fault = error;
  }
}

export const captureWorkflow = async <T>(operation: () => Promise<T>) => {
  try {
    return { value: await operation() };
  } catch (cause) {
    if (cause instanceof NativeWorkflowError) return { error: cause.fault, native: true };

    return { error: fault(cause) };
  }
};

// Native step callbacks cross another RPC boundary into the Workflows engine.
// Keep the canonical NonRetryableError name there; a custom name loses its
// retry semantics. The message carries the original fault through persistence.
export const nativeWorkflowError = (error: Fault) => {
  const message = `WIDEFLEET_WORKFLOW_ERROR:${JSON.stringify(error)}`;

  return error.nonRetryable ? new NonRetryableError(message) : new Error(message);
};

const transportedFault = z.object({
  name: z.string(),
  message: z.string(),
  nonRetryable: z.boolean().optional(),
});

export const nativeWorkflowFault = (error: Fault): Fault => {
  const encoded = /^(?:Error: |NonRetryableError: )?WIDEFLEET_WORKFLOW_ERROR:(.+)$/s.exec(
    error.message,
  )?.[1];

  if (encoded) {
    try {
      const decoded = transportedFault.safeParse(JSON.parse(encoded));

      if (decoded.success)
        return { ...decoded.data, nonRetryable: decoded.data.nonRetryable ?? false };
    } catch {
      // A native error without our envelope remains an ordinary engine error.
    }
  }

  return error;
};
