---
title: Use an app template
description: Find a ready-made app and set it up with your agent or the CLI.
lastModified: 2026-11-10
---

App templates give you source code and instructions for a working app. Deploy a
template into your organization, then use and customize it like any other app.

Sign in to the organization where you want the app. Your agent needs the
[Widefleet CLI](/getting-started/installation) and access to that organization.
Check the template's instructions for any credentials or permissions it requires.

## Start from the catalog

1. Open **App catalog → Templates** in the control plane.
2. Choose a template and read its description and instructions.
3. Copy the prompt under **Set up with your agent** and paste it into your agent.

The prompt selects your installation and organization. Your agent reads the same
instructions through the CLI, checks for an existing app to reuse, and helps you
deploy and configure the app.

If copying is unavailable, select the prompt text and copy it manually.

## Find templates from the CLI

An agent already working with Widefleet can discover templates directly:

```sh
widefleet catalog templates list
widefleet catalog templates list --search mail
widefleet catalog templates show gmail
```

The commands return JSON. A template includes its source URL and the Markdown
instructions from its `template.md` file. Follow those instructions to copy,
deploy and configure the app. Keep the copied source for future changes.

Use `--organization ID` when you work across organizations. See
[organization selection](/reference/cli-configuration#select-an-organization).

## Complete setup and use the app

Follow the template's setup steps and verify the result with its usage example.
For an app that connects personal accounts, complete account sign-in in your
browser. Provide credentials through the app's **Secrets** tab or the CLI's
protected-file input.

If the app provides an API, follow its instructions to use it from another app.
See [Connect apps](/guides/app-services) for connection setup and permissions.

For apps already published by your organization, use **Published apps** in the
catalog or `widefleet catalog list` to find their launch URLs.

## Create an app for another use case

Open **App not here? Create one with your agent** below the templates. Copy the
prompt and describe what you need. Your agent can also read this prompt from
`widefleet catalog templates list` as `createPrompt`.

The [app development guide](/guides/app-development) covers building and
deploying your own app.
