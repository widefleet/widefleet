---
title: Workflows
description: Declare durable background work and manage Workflow instances.
---

App runtime 0.2.0 supports Cloudflare-style Workflows in Dynamic Workers on the unchanged celld 0.6.2 release. CLI configuration and management commands for Workflows require CLI and platform 0.3.0 or newer; use matching CLI, control-plane and agent versions. Update the deployment agent and select a runtime release advertising `workflows: 1` before deploying Workflow bindings. Runtime downgrades without this capability are rejected while published apps retain Workflow versions.

## Declare and export a Workflow

Add a standard `workflows` entry to the app's Wrangler configuration:

```jsonc
{
  "name": "example",
  "main": "worker.ts",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "public", "binding": "ASSETS" },
  "workflows": [{ "binding": "PROCESS", "name": "process", "class_name": "Process" }],
}
```

The configured main module must export both the ordinary Worker handler and the named Workflow class:

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Parameters = { message: string };
type Environment = { PROCESS: Workflow<Parameters> };

export class Process extends WorkflowEntrypoint<Environment, Parameters> {
  async run(event: WorkflowEvent<Parameters>, step: WorkflowStep) {
    const message = await step.do("prepare", async () => event.payload.message.trim());
    const approval = await step.waitForEvent<{ accepted: boolean }>("approval", {
      type: "approval",
      timeout: "1 day",
    });
    return step.do("finish", async () => ({ message, accepted: approval.payload.accepted }));
  }
}

export default {
  async fetch(request: Request, env: Environment) {
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });
    const instance = await env.PROCESS.create({ params: { message: "Example" } });
    return Response.json({ id: instance.id });
  },
};
```

For this standalone example, save the files as `wrangler.jsonc` and `worker.ts`, create the configured asset directory, and deploy from that directory with your ordinary login:

```sh
mkdir -p public
widefleet deploy --skip-build
```

`--skip-build` skips a project build script; the CLI still bundles `worker.ts`. For generated framework Workers, use a main-module wrapper that re-exports the generated default handler and your Workflow classes. Ensure the framework build runs before `widefleet deploy`. The platform validates every declared Workflow export before activating a deployment. Cross-script Workflow declarations are not supported; each app owns its bindings.

## Manage instances

App code can use `create`, `createBatch`, `get`, `deleteBatch`, and instance `status`, `sendEvent`, `pause`, `resume`, `restart`, `terminate`, and `delete`. Batch methods accept 1–100 entries. Instance IDs are scoped to an app and Workflow name. Creation supports native retention and location options.

The CLI resolves `--app NAME_OR_ID` or the current project's name. Create the two JSON payload files used by this example:

```sh
printf '%s\n' '{"message":"Example"}' > parameters.json
printf '%s\n' '{"accepted":true}' > approval.json
```

Create an instance, then approve it:

```sh
widefleet workflows definitions
widefleet workflows create process --id example-1 --params parameters.json
widefleet workflows list process
widefleet workflows status process example-1
widefleet workflows send-event process example-1 approval --payload approval.json
widefleet workflows status process example-1
```

After completion, `status` returns the output `{ "message": "Example", "accepted": true }`. For lifecycle controls, restart the instance so that it waits for a new approval before pausing or terminating it:

```sh
widefleet workflows restart process example-1
widefleet workflows pause process example-1
widefleet workflows resume process example-1
widefleet workflows terminate process example-1
widefleet workflows delete process example-1
```

Commands print JSON. `--no-wait` returns a queued operation; `widefleet workflows operation OPERATION_UUID` retrieves its outcome. `list --cursor CURSOR` requests the next page. Restart begins again on the instance's original code version and may repeat side effects.

The app detail page exposes the same operations. Requests remain visibly pending until the fleet agent confirms their outcome. Workflow names from earlier deployments can still be entered to manage their existing instances.

HTTP management endpoints are:

| Endpoint under `/api/v1/apps/{appId}` | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `GET /workflows`                      | Current declarations                              |
| `POST /workflows/query`               | Queue a `list` or `status` query; `platform:read` |
| `POST /workflows`                     | Queue a mutation; `platform:write`                |
| `GET /workflows/operations/{jobId}`   | Read a queued operation's state and result        |

POST bodies contain a `request` object, for example `{"request":{"action":"create","workflow":"process","id":"example-1","params":{"message":"Example"}}}`. Supply a UUID `Idempotency-Key` header. All endpoints require management access to the app. Management payloads are JSON and bounded to 64 KiB; app-side bindings retain native structured-clone values. Management renders non-JSON outputs with `$type` tags (for example `BigInt`, `Map`, and binary values); repeated object references use `$ref` indices. Listings return instance summaries; use `status` for the output.

## Persistence and permissions

A trusted native Workflow drives the app coroutine through a scoped RPC session. App code and callbacks execute inside a separate Dynamic Worker with the existing storage facades, connector grants, telemetry and egress policy. No app callback or native step object crosses RPC. celld owns retries, durable step results, event buffering and timers.

Native checkpoints record command identities, their batch order and which parallel result was delivered next. Replay matches each step by its name and occurrence count, holding early commands until their recorded turn. Committed callback results reconstruct the app coroutine without re-executing committed callbacks. Step names and occurrence counts exposed to app callbacks retain their original values. Parallel branches whose registration order can vary must use distinct step names; repeated uses of the same name must retain their order across replay. Side effects outside steps can repeat during replay; side effects inside an uncommitted or retried step must also tolerate repetition.

Each instance pins its immutable app version. Redeployment and rollback affect new instances. Existing instances keep their code and declared storage resources, even if a later deployment removes the Workflow or storage declaration. The current network policy and still-granted connector bindings are selected when a Workflow session is reconstructed. Revocation does not undo an already completed external request.

The agent retains resource declarations from Workflow-bearing app versions until the app is deleted. App deletion gates new creation, deletes the app's native Workflow instances, and then removes published files and resources through the existing removal process. Instance metadata can outlive the native engine's result retention and appear as `expired` in listings. Deleting an expired instance removes its catalog entry and releases its ID for reuse. Runtime limits, including native value-size bounds, still apply; internal checkpoint and start envelopes consume part of those bounds.

Management request IDs have durable receipts. A retry returns the recorded result. If a process dies after recording intent but before recording the native operation's outcome, the retry reports an unknown outcome and does not repeat the mutation. Inspect the instance before submitting a new request ID, especially for events and restarts.

## Supported step API and limits

Supported operations are `step.do`, `step.sleep`, `step.sleepUntil` and `step.waitForEvent`, including parallel branches, repeated step names, native static-delay retry policies, callback attempt context and `NonRetryableError`. `sleepUntil` requires a future deadline when scheduled, as in celld. Do not nest step calls inside a `step.do` callback.

Short global `setTimeout` waits and `fetch` calls (including response body methods such as `json()` and `text()`) can run between steps while another branch waits for an event. They repeat on replay. Command delivery has a 60-second timeout; use durable steps for longer work. Put other asynchronous I/O, such as direct connector calls, Node APIs and manual stream reads, inside `step.do`, and use `step.sleep` for durable delays.

Function-valued retry delays, selective restart from a named step, step rollback handlers and rollback-on-termination are not supported. Unsupported options are rejected. Workflow scheduling/facets and cross-app bindings are not part of this interface. This adapter does not claim compatibility with every Cloudflare Workflow extension.

Cloudflare's `@cloudflare/dynamic-workflows` helper cannot directly supply this transport on celld 0.6.2: dynamic Workflow entrypoint lookup and native step-object transport are unavailable. The platform preserves the supported app API with its own transport, without patching or forking celld.
