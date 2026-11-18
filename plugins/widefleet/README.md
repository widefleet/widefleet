# Widefleet plugin

Build, deploy and use internal apps on [Widefleet](https://widefleet.com) from ChatGPT and Claude.

The plugin connects the Widefleet MCP server, which lets the assistant find and call the APIs
of apps your organization already runs. Its `widefleet` skill tells the assistant to build and
deploy apps with the Widefleet CLI in its shell and points it to the
[documentation](https://widefleet.com/docs) for each step.

## Install

In Claude Code 2.1.275 or newer:

```sh
/plugin install widefleet --marketplace widefleet/widefleet
```

In older versions, add the marketplace first:

```sh
/plugin marketplace add widefleet/widefleet
/plugin install widefleet@widefleet
```

## Contents

- `plugin.json` and `mcp.json`: ChatGPT plugin manifest and MCP server.
- `.claude-plugin/plugin.json` and `.mcp.json`: Claude plugin manifest and MCP server.
- `skills/widefleet/SKILL.md`: the skill shared by both.

Connecting the MCP server signs you in to your organization. Building and deploying apps
requires a shell with Node.js 22.18 or newer.

## Privacy and license

See the [privacy policy](https://widefleet.com/privacy). Licensed under MIT.
