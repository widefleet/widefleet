---
title: Use an app template
description: Find a ready-made app and set it up with your agent or the CLI.
lastModified: 2026-11-10
---

App templates give you working source code and setup instructions for common
integrations. Deploy a template into your organization, then use and customize
it like any other app.

Sign in to the organization where you want the app. Your agent needs the
[Widefleet CLI](/getting-started/installation) and access to that organization.
Check the template's setup requirements: connecting external accounts needs
an administrator to configure provider credentials and app permissions.

## Start from the catalog

1. Open **App catalog → Templates** in the control plane.
2. Choose a template and review what it does and what account setup requires.
3. Copy the prompt under **Set up with your agent** and paste it into your agent.

The prompt selects your installation and organization. Your agent reads the
same template instructions through the CLI, checks for an existing app to reuse,
and helps you deploy and configure the app. You complete any personal account
sign-in in your browser.

If copying is unavailable, select the prompt text and copy it manually.

## Find templates from the CLI

An agent already working with Widefleet can discover templates directly:

```sh
widefleet catalog templates list
widefleet catalog templates list --search mail
widefleet catalog templates show gmail
```

The commands return JSON. Each template includes its source location,
capabilities, setup instructions, required secrets, network destinations and
usage examples. Follow those instructions using the existing deployment and
configuration commands. Keep the copied source for future changes.

Use `--organization ID` when you work across organizations. See
[organization selection](/reference/cli-configuration#select-an-organization).

## Complete setup and use the app

After deployment, open the app URL and complete the steps shown there. For a
personal account integration, an administrator configures the provider's OAuth
application and app secrets; each person then connects their own account.
Enter credentials through the app's **Secrets** tab or the CLI's protected-file
input.

If the app provides an API, follow the template's examples to use it from
another app. An administrator grants that app connection. See
[Connect apps](/guides/app-services) for connection setup and permissions.

Verify the result with the template's suggested check. A deployed app can still
need credentials or account sign-in before its integration works; its setup
page identifies the remaining steps.

For apps already published by your organization, use **Published apps** in the
catalog or `widefleet catalog list` to find their launch URLs.

## Create an app for another use case

Open **App not here? Create one with your agent** below the templates. Copy the
prompt and describe what you need. Your agent can also read this prompt from
`widefleet catalog templates list` as `createPrompt`.

The [app development guide](/guides/app-development) covers building and
deploying your own app.
