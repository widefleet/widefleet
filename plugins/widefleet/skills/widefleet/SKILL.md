---
name: widefleet
description: Build, change, preview and deploy apps on Widefleet, or continue work on an existing Widefleet app. Use whenever the user wants to create an app or internal tool, publish or update an app, or find out why a deployment failed.
---

# Widefleet

Apps are built and deployed with the Widefleet CLI in your shell. The Widefleet MCP
tools only use apps that are already running; they cannot create or deploy apps.
If you have a shell, use it. Do not tell the user that deployment is unavailable.

Install the CLI with `pnpm add --global widefleet` (install pnpm first if it is
missing), then sign in. With the Widefleet MCP tools connected, run the command
that the `cli_login` tool returns; it needs no browser. Otherwise run
`widefleet login` and share the printed link with the user.
If your sandbox keeps only the working directory between commands, first set
`PLATFORM_SESSION_FILE` to a file there, outside the app project, and keep it set.

Before creating an app, check what the organization already has:

- `widefleet apps` lists existing apps. Change one when it already does most of what
  the user wants.
- `widefleet catalog templates list --search TEXT` finds ready-made apps for services
  such as Gmail, GitHub, Linear or Outlook. When the app needs one of these services,
  suggest the template to the user, install it and call it from your app with
  `widefleet connect` instead of writing the integration yourself.

If a command fails, fix the cause or retry it. Do not deploy with `--no-source`
as a workaround; the app's source code would not be saved.

Read the documentation before acting, and follow it over your memory:
https://widefleet.com/docs/llms.txt

Start with:

- Installation and login: https://widefleet.com/docs/getting-started/installation.md
- Deployments: https://widefleet.com/docs/guides/deployments.md
- Source code from earlier sessions: https://widefleet.com/docs/guides/source-code.md
- App templates: https://widefleet.com/docs/guides/app-templates.md

Every app opens only after the organization's sign-in, which Widefleet provides. Do not
ask the user for an identity provider, domain or login setup. Restrict an app to company
groups only when the user asks for it.

Ask the user before deleting anything or changing access, secrets or data.
