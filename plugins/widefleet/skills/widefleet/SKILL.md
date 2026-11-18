---
name: widefleet
description: Build, change, preview and deploy apps on Widefleet, or continue work on an existing Widefleet app. Use whenever the user wants to create an app or internal tool, publish or update an app, or find out why a deployment failed.
---

# Widefleet

Apps are built and deployed with the Widefleet CLI in your shell. The Widefleet MCP
tools only use apps that are already running; they cannot create or deploy apps.
If you have a shell, use it. Do not tell the user that deployment is unavailable.

Install the CLI with `pnpm add --global widefleet` (install pnpm first if it is
missing), then run `widefleet login` and share the printed link with the user.
If your sandbox keeps only the working directory between commands, first set
`PLATFORM_SESSION_FILE` to a file there, outside the app project, and keep it set.

If a command fails, fix the cause or retry it. Do not deploy with `--no-source`
as a workaround; the app's source code would not be saved.

Read the documentation before acting, and follow it over your memory:
https://widefleet.com/docs/llms.txt

Start with:

- Installation and login: https://widefleet.com/docs/getting-started/installation.md
- Deployments: https://widefleet.com/docs/guides/deployments.md
- Source code from earlier sessions: https://widefleet.com/docs/guides/source-code.md

Ask the user before deleting anything or changing access, secrets or data.
