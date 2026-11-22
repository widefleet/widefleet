// Compiled by `pnpm typecheck`: the results a consuming app sees for typed selections.
import type Linear from "../src/app.ts";

declare const linear: Linear;

export const selections = async () => {
  const issue = await linear.issue(
    { id: "ENG-123" },
    {
      id: true,
      title: true,
      team: { name: true },
      labels: { $args: { first: 5 }, nodes: { name: true } },
    },
  );

  if (issue.status === "connected") {
    const title: string = issue.data.title;
    const team: string = issue.data.team.name;
    const label: string | undefined = issue.data.labels.nodes[0]?.name;
    // @ts-expect-error Not selected.
    void issue.data.description;
    // @ts-expect-error The identifier is a string.
    const wrong: number = issue.data.id;
    void [title, team, label, wrong];
  }

  // @ts-expect-error Issue has no such field.
  await linear.issue({ id: "ENG-1" }, { notAField: true });
  // @ts-expect-error A related object needs a nested selection.
  await linear.issue({ id: "ENG-1" }, { team: true });
  // @ts-expect-error Arguments have their schema types.
  await linear.issue({ id: "ENG-1" }, { labels: { $args: { first: "5" }, nodes: { id: true } } });

  const page = await linear.issues(
    { first: 10, filter: { assignee: { isMe: { eq: true } } } },
    { nodes: { identifier: true, assignee: { displayName: true } } },
  );

  if (page.status === "connected") {
    const assignee: string | undefined = page.data.nodes[0]?.assignee?.displayName;
    void assignee;
  }

  const notification = await linear.notification(
    { id: "notification-1" },
    { id: true, $on: { IssueNotification: { issue: { identifier: true } } } },
  );

  if (notification.status === "connected" && notification.data.__typename === "IssueNotification") {
    const identifier: string | undefined = notification.data.issue?.identifier;
    void identifier;
  }

  // Clearing a nullable field passes null.
  const updated = await linear.issueUpdate(
    { id: "ENG-1", input: { assigneeId: null } },
    { success: true },
  );

  if (updated.resultType === "input_required") void updated.inputRequests.approve.message;
};
