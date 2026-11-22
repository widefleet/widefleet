// Compiled by `pnpm typecheck`: the results a consuming app sees for typed selections.
import type GitHub from "../src/app.ts";

declare const github: GitHub;

export const selections = async () => {
  const repository = await github.repository(
    { owner: "example", name: "project" },
    {
      nameWithOwner: true,
      defaultBranchRef: { name: true },
      issues: { $args: { first: 5, states: ["OPEN"] }, nodes: { number: true, title: true } },
    },
  );

  if (repository.status === "connected" && repository.data) {
    const name: string = repository.data.nameWithOwner;
    const branch: string | undefined = repository.data.defaultBranchRef?.name;
    const issue: number | undefined = repository.data.issues.nodes?.[0]?.number;
    // @ts-expect-error Not selected.
    void repository.data.description;
    void [name, branch, issue];
  }

  // @ts-expect-error Repository has no such field.
  await github.repository({ owner: "example", name: "project" }, { notAField: true });
  // @ts-expect-error Nested selections are checked too.
  await github.repository({ owner: "o", name: "n" }, { owner: { login: true, logn: true } });
  // @ts-expect-error A related object needs a nested selection.
  await github.repository({ owner: "o", name: "n" }, { owner: true });
  await github.repository(
    { owner: "o", name: "n" },
    // @ts-expect-error Arguments have their schema types.
    { issues: { $args: { first: "5" }, totalCount: true } },
  );
  // @ts-expect-error A method's required arguments must be passed.
  await github.repository({ owner: "o" }, { id: true });

  const node = await github.node(
    { id: "I_1" },
    { id: true, $on: { Issue: { title: true }, PullRequest: { mergeable: true } } },
  );

  if (node.status === "connected" && node.data?.__typename === "Issue") {
    const title: string = node.data.title;
    void title;
  }

  const created = await github.createIssue(
    { input: { repositoryId: "R_1", title: "Bug" } },
    { issue: { number: true } },
  );

  if (created.resultType === "input_required") void created.inputRequests.approve.message;
  else if (created.status === "connected") {
    const number: number | undefined = created.data?.issue?.number;
    void number;
  }

  // A file's text, as template.md describes it.
  const file = await github.repository(
    { owner: "example", name: "project" },
    { object: { $args: { expression: "main:README.md" }, $on: { Blob: { text: true } } } },
  );

  if (file.status === "connected" && file.data?.object?.__typename === "Blob") {
    const text: string | null | undefined = file.data.object.text;
    void text;
  }
};
