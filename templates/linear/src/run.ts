import { z } from "zod";
import { approvalAnswer, approvals, asks, type Change, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { graphqlRequest } from "./graphql.ts";
import { type Arguments, definedJson, type FieldSelection } from "./input.ts";
import type { LinearResult } from "./results.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type LinearProperties = Properties & { input?: z.input<typeof approvalAnswer> };

/** One query or mutation of Linear's schema, and the change a mutation makes. */
export type Operation = { root: "Query" | "Mutation"; field: string; change: Change | null };

/**
 * Runs one query or mutation for the current user. The request is checked
 * against Linear's schema before anything is asked or sent. A change asks the
 * user first when their approval level says so, and runs only after approval.
 */
export const run = async <T>(
  environment: Environment,
  properties: LinearProperties,
  operation: Operation,
  input: Arguments,
  select?: FieldSelection,
): Promise<LinearResult<T>> => {
  const request = graphqlRequest(operation.root, operation.field, input, select);
  const connection = accountConnection(environment, properties);

  if (operation.change) {
    // A question only helps a user who can run the change afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

      // The question shows the input as Linear receives it.
      if (!answer)
        return changeQuestion(
          "Linear",
          operation.field,
          operation.change,
          definedJson.parse(input),
        );

      if (answer.action !== "accept") return { status: "declined" };
    }
  }

  const response = await connection.graphql(request);

  if (response.status !== "connected") return response;

  // SAFETY: Linear answered the request written from this method's selection,
  // which its generated signature types as T.
  return { status: "connected", data: response.data[operation.field] as T };
};
