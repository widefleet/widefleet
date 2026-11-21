import { z } from "zod";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";
import { approvalAnswer, approvalRequest, callTool, toolOutput } from "./linear.ts";

export type Json = z.infer<ReturnType<typeof z.json>>;

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type LinearProperties = Properties & { input?: z.input<typeof approvalAnswer> };

/** What a generated method knows about its tool from Linear's tool list. */
export type ToolPolicy = {
  title: string;
  approval: boolean;
  schema: z.core.JSONSchema.JSONSchema;
};

// Each tool's JSON Schema, compiled once per isolate.
const validators = new Map<string, z.ZodType>();

const validator = (name: string, schema: ToolPolicy["schema"]) => {
  const known = validators.get(name);

  if (known) return known;
  const compiled = z.fromJSONSchema(schema);
  validators.set(name, compiled);

  return compiled;
};

/**
 * Runs one Linear tool for the current user. Arguments are checked against the
 * tool's schema before anything is sent or asked. Tools that can delete or
 * overwrite data ask the user first and run only after approval.
 */
export const runTool = async (
  environment: Environment,
  properties: LinearProperties,
  name: string,
  input: Record<string, Json>,
  policy: ToolPolicy,
) => {
  validator(name, policy.schema).parse(input);
  const connection = accountConnection(environment, properties);

  if (policy.approval) {
    // A question only helps a user who can run the tool afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

    if (!answer) return approvalRequest(policy.title, input);

    if (answer.action !== "accept") return { status: "declined" } as const;
  }

  const response = await connection.rpc(callTool({ name, arguments: input }));

  if (response.status !== "connected") return response;

  return toolOutput(response.result);
};
