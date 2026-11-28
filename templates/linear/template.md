---
name: Linear
description: Read and change a Linear workspace through Linear's complete GraphQL API, with typed results.
---

Work with Linear issues, projects, cycles, comments, documents and initiatives from
your agents and apps. Each person connects their own Linear account.

## Set up

Install the template, open the app and connect your Linear account.

If the app asks for `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, your installation
uses your own Linear OAuth application: create one in Linear's API settings with the
callback URL `https://YOUR-APP-HOST/auth/callback/linear` and save its credentials on
the app's **Secrets** page.

## Use it

Ask your agent, for example "Show my open Linear issues for this cycle". To call it
from your own app, connect it from the app's directory:

```sh
widefleet connect linear --as LINEAR
```

Linear's GraphQL queries and mutations for a person's workspace are methods with the
same name, such as `issues`, `issueCreate` and `commentCreate`. Linear's sign-in
flows, agent-app and OAuth application management and internal operations are left
out; `scripts/operations.ts` lists each with its reason. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
