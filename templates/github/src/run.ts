import { z } from "zod";
import { approvalAnswer, approvals, asks, type Change, changeQuestion } from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { graphqlRequest, graphqlResult } from "./graphql.ts";
import { type Arguments, definedJson, type FieldSelection } from "./input.ts";
import type { GitHubResult } from "./results.ts";

/** Props of a call, with the user's answer when Widefleet calls again after a question. */
export type GitHubProperties = Properties & { input?: z.input<typeof approvalAnswer> };

/** One query or mutation of GitHub's schema, and the change a mutation makes. */
export type Operation = { root: "Query" | "Mutation"; field: string; change: Change | null };

/**
 * Runs one query or mutation for the current user. The request is checked
 * against GitHub's schema before anything is asked or sent. A change asks the
 * user first when their approval level says so, and runs only after approval.
 */
export const run = async <T>(
  environment: Environment,
  properties: GitHubProperties,
  operation: Operation,
  input: Arguments,
  select?: FieldSelection,
): Promise<GitHubResult<T>> => {
  const request = graphqlRequest(operation.root, operation.field, input, select);
  const connection = accountConnection(environment, properties);

  if (operation.change) {
    // A question only helps a user who can run the change afterwards.
    const status = await connection.status();

    if (status.status !== "connected") return status;
    const id = await callerId(caller.parse(properties.caller));

    if (asks(await approvals(environment.DB, id).level(), operation.change)) {
      const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

      // The question shows the input as GitHub receives it.
      if (!answer)
        return changeQuestion(
          "GitHub",
          operation.field,
          operation.change,
          definedJson.parse(input),
        );

      if (answer.action !== "accept") return { status: "declined" };
    }
  }

  const response = await connection.graphql(request);

  if (response.status !== "connected") return response;

  // SAFETY: GitHub answered the request written from this method's selection,
  // which its generated signature types as T.
  return {
    status: "connected",
    data: graphqlResult(
      operation.root,
      operation.field,
      select,
      response.data[operation.field] ?? null,
    ) as T,
  };
};
