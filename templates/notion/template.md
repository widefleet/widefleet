---
name: Notion
description: Read and write Notion pages, databases, comments and files and chat with Custom Agents through Notion's API, with typed results.
---

Work with Notion pages and their content, databases, data sources and views,
comments, file uploads, meeting notes and Custom Agents from your agents and apps.
Each person connects their own Notion account and chooses which pages to share.

## Set up

Install the template, open the app and connect your Notion account.

If the app asks for `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`, your installation
uses your own Notion OAuth integration:

1. In Notion's [Developer portal](https://app.notion.com/developers/connections),
   create a connection with the authentication method **OAuth** and add
   `https://YOUR-APP-URL/auth/callback/notion` as a redirect URI. Under
   **Installable in**, choose the workspaces your people use.
2. On the **Configuration** tab, select every content, comment and agent capability
   and **User information with email addresses**.
3. Save the OAuth client ID and client secret as `NOTION_CLIENT_ID` and
   `NOTION_CLIENT_SECRET` on the app's **Secrets** page.

## Use it

Ask your agent, for example "Add my meeting notes to the Roadmap page". To call it
from your own app, connect it from the app's directory:

```sh
widefleet connect notion --as NOTION
```

Each operation of Notion's API is a method, such as `search`, `createPage`,
`queryDataSource` and `updatePageMarkdown`. The app reaches the pages the person
shared when connecting. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
