import { describe, expect, it } from "vitest";
import { graphqlRequest } from "./graphql.ts";
import { type Arguments, type FieldSelection, InvalidRequest } from "./input.ts";

describe("GitHub GraphQL requests", () => {
  it("passes every argument as a variable of its schema type", () => {
    expect(
      graphqlRequest(
        "Query",
        "repository",
        { owner: "example", name: "project", followRenames: undefined },
        {
          issues: {
            $args: { first: 3, states: ["OPEN"] },
            nodes: {
              number: true,
              title: true,
              labels: { $args: { first: 5 }, nodes: { name: true } },
            },
          },
        },
      ),
    ).toEqual({
      query:
        "query($v0: String!, $v1: String!, $v2: Int, $v3: [IssueState!], $v4: Int) { repository(owner: $v0, name: $v1) { issues(first: $v2, states: $v3) { nodes { number title labels(first: $v4) { nodes { name } } } } } }",
      variables: { v0: "example", v1: "project", v2: 3, v3: ["OPEN"], v4: 5 },
    });
  });

  it("writes mutations, interfaces and unions", () => {
    expect(
      graphqlRequest(
        "Mutation",
        "createIssue",
        { input: { repositoryId: "R_1", title: "Bug", body: undefined } },
        { issue: { number: true, url: true } },
      ),
    ).toEqual({
      query:
        "mutation($v0: CreateIssueInput!) { createIssue(input: $v0) { issue { number url } } }",
      variables: { v0: { repositoryId: "R_1", title: "Bug" } },
    });
    expect(
      graphqlRequest("Query", "node", { id: "I_1" }, { id: true, $on: { Issue: { title: true } } })
        .query,
    ).toBe("query($v0: ID!) { node(id: $v0) { id __typename ... on Issue { title } } }");
    // A union or interface result always carries its concrete type.
    expect(
      graphqlRequest(
        "Query",
        "search",
        { query: "is:open", type: "ISSUE", first: 5 },
        { nodes: { $on: { PullRequest: { number: true } } } },
      ).query,
    ).toBe(
      "query($v0: String!, $v1: SearchType!, $v2: Int) { search(query: $v0, type: $v1, first: $v2) { nodes { __typename ... on PullRequest { number } } } }",
    );
  });

  it("rejects requests that do not match GitHub's schema before sending them", () => {
    const invalid = (input: Arguments, select: FieldSelection | undefined) => () =>
      graphqlRequest("Query", "repository", input, select);

    const input = { owner: "example", name: "project" };

    expect(invalid({ ...input, unknown: 1 }, { id: true })).toThrow(
      new InvalidRequest("repository has no argument unknown"),
    );
    expect(invalid(input, undefined)).toThrow("repository needs a selection of Repository fields");
    expect(invalid(input, { owner: true })).toThrow(
      "Select fields of RepositoryOwner for Repository.owner",
    );
    expect(invalid(input, { issues: { $args: { constructor: 1 }, totalCount: true } })).toThrow(
      "Repository.issues has no argument constructor",
    );
    expect(invalid({ ...input, name: Number.NaN }, { id: true })).toThrow(InvalidRequest);
  });
});
