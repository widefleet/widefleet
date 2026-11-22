import { describe, expect, it } from "vitest";
import { type Arguments, type FieldSelection, graphqlRequest, InvalidRequest } from "./graphql.ts";

describe("Linear GraphQL requests", () => {
  it("passes every argument as a variable of its schema type", () => {
    expect(
      graphqlRequest(
        "Query",
        "issues",
        { first: 10, filter: { assignee: { isMe: { eq: true } } }, after: undefined },
        { nodes: { identifier: true, labels: { $args: { first: 3 }, nodes: { name: true } } } },
      ),
    ).toEqual({
      query:
        "query($v0: Int, $v1: IssueFilter, $v2: Int) { issues(first: $v0, filter: $v1) { nodes { identifier labels(first: $v2) { nodes { name } } } } }",
      variables: { v0: 10, v1: { assignee: { isMe: { eq: true } } }, v2: 3 },
    });
  });

  it("writes mutations, unions and fields of scalar type with arguments", () => {
    expect(
      graphqlRequest(
        "Mutation",
        "issueUpdate",
        { id: "ENG-1", input: { assigneeId: null } },
        {
          success: true,
        },
      ),
    ).toEqual({
      query:
        "mutation($v0: String!, $v1: IssueUpdateInput!) { issueUpdate(id: $v0, input: $v1) { success } }",
      variables: { v0: "ENG-1", v1: { assigneeId: null } },
    });
    expect(
      graphqlRequest(
        "Query",
        "notification",
        { id: "n-1" },
        {
          id: true,
          $on: { IssueNotification: { issue: { identifier: true } } },
        },
      ).query,
    ).toBe(
      "query($v0: String!) { notification(id: $v0) { id __typename ... on IssueNotification { issue { identifier } } } }",
    );
    // A union or interface result always carries its concrete type.
    expect(graphqlRequest("Query", "notification", { id: "n-1" }, { id: true }).query).toBe(
      "query($v0: String!) { notification(id: $v0) { __typename id } }",
    );
    expect(
      graphqlRequest(
        "Query",
        "team",
        { id: "t-1" },
        { issueCount: { $args: { includeArchived: true } } },
      ).query,
    ).toBe(
      "query($v0: String!, $v1: Boolean) { team(id: $v0) { issueCount(includeArchived: $v1) } }",
    );
  });

  it("leaves out undefined input at every depth", () => {
    expect(
      graphqlRequest(
        "Mutation",
        "issueCreate",
        { input: { teamId: "team-1", description: undefined } },
        { success: true },
      ),
    ).toEqual({
      query: "mutation($v0: IssueCreateInput!) { issueCreate(input: $v0) { success } }",
      variables: { v0: { teamId: "team-1" } },
    });
  });

  it("rejects numbers JSON cannot carry instead of sending null", () => {
    for (const estimate of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        graphqlRequest(
          "Mutation",
          "issueUpdate",
          { id: "ENG-1", input: { estimate } },
          {
            success: true,
          },
        ),
      ).toThrow(InvalidRequest);
  });

  it("rejects requests that do not match Linear's schema before sending them", () => {
    const invalid = (input: Arguments, select: FieldSelection | undefined) => () =>
      graphqlRequest("Query", "issue", input, select);

    expect(invalid({ id: "ENG-1", unknown: 1 }, { id: true })).toThrow(
      new InvalidRequest("issue has no argument unknown"),
    );
    expect(invalid({ id: "ENG-1" }, undefined)).toThrow("issue needs a selection of Issue fields");
    expect(invalid({ id: "ENG-1" }, {})).toThrow("Select at least one field of Issue");
    expect(invalid({ id: "ENG-1" }, { team: true })).toThrow(
      "Select fields of Team for Issue.team",
    );
    expect(invalid({ id: "ENG-1" }, { "id }": true })).toThrow("Issue has no field id }");
    expect(invalid({ id: "ENG-1" }, { team: { $args: { constructor: 1 }, id: true } })).toThrow(
      "Issue.team has no argument constructor",
    );
    expect(invalid({ id: "ENG-1" }, { $on: { constructor: { id: true } } })).toThrow(
      "$on of Issue names no type constructor",
    );
    expect(invalid({ id: "ENG-1" }, { title: 1 })).toThrow(
      "Select Issue.title with true or an object",
    );
  });
});
