---
title: Workflows
description: Declare durable background work and manage Workflow instances.
lastModified: 2026-11-18
---

Use a Workflow for multi-step background work that must survive restarts, wait
for events or timers, and retry individual steps. Apps use the standard
Cloudflare Workflows API; you manage instances from app code, the CLI, the app
detail page or the HTTP API.

You need the Widefleet CLI and permission to deploy and manage the app.

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

`--skip-build` skips a project build script; the CLI still bundles `worker.ts`. For generated framework Workers, use a main-module wrapper that re-exports the generated default handler and your Workflow classes, and run the framework build before `widefleet deploy`. Widefleet validates every declared Workflow export before it activates a deployment. Each app declares and runs its own Workflows; bindings to another app's Workflows are not supported.

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

Commands print JSON. `--no-wait` returns a queued operation; `widefleet workflows operation OPERATION_UUID` retrieves its outcome. `list --cursor CURSOR` requests the next page. Restart without a step selector begins again from the first step on the instance's original code version and may repeat side effects.

The app detail page offers the same operations and shows each request as pending until it completes. You can also enter Workflow names from earlier deployments to manage their existing instances.

### Deployments and deletion

- Each instance runs the app version it started with. Redeployments and rollbacks apply to new instances; to run a fix, create a new instance.
- Existing instances keep their declared storage resources, even if a later deployment removes the Workflow or storage declaration.
- When an instance resumes, it uses the app's current network permissions, connections and secrets.
- Listings can show `expired` for instances whose results are past retention. Deleting an expired instance releases its ID for reuse.
- Deleting the app deletes its Workflow instances.

### HTTP API

| Endpoint under `/api/v1/apps/{appId}` | Purpose                                           |
| ------------------------------------- | ------------------------------------------------- |
| `GET /workflows`                      | Current declarations                              |
| `POST /workflows/query`               | Queue a `list` or `status` query; `platform:read` |
| `POST /workflows`                     | Queue a mutation; `platform:write`                |
| `GET /workflows/operations/{jobId}`   | Read a queued operation's state and result        |

POST bodies contain a `request` object, for example `{"request":{"action":"create","workflow":"process","id":"example-1","params":{"message":"Example"}}}`. All endpoints require management access to the app. Management payloads are JSON of up to 64 KiB; app-side bindings accept native structured-clone values. Non-JSON outputs are tagged with `$type` (for example `BigInt`, `Map` and binary values), and repeated object references use `$ref` indices. Listings return instance summaries; use `status` for the output.

Supply a UUID `Idempotency-Key` header. Retrying with the same key returns the recorded result. If the response says the previous outcome is unknown, check the instance's `status` before you submit the change with a new key, especially for events and restarts.

## Restart from a step

Use selective restart to repeat part of an instance while keeping earlier step results. The target must already exist in that instance's execution history. These examples use the Workflow definition and JSON files above; create a separate instance so that it has not been deleted by the lifecycle example:

```sh
widefleet workflows create process --id example-restart-1 --params parameters.json
widefleet workflows send-event process example-restart-1 approval --payload approval.json
widefleet workflows status process example-restart-1
```

Once `status` reports `complete`, repeat only `finish`:

```sh
widefleet workflows restart process example-restart-1 --from-step-name finish
widefleet workflows status process example-restart-1
```

The instance completes again with the original prepared message and approval. It does not wait for another approval. From an app handler with access to `env.PROCESS`, the equivalent call is:

```ts
const instance = await env.PROCESS.get("example-restart-1");
await instance.restart({ from: { name: "finish" } });
```

The selector supports repeated names and different step types:

| Binding/API field | CLI flag            | Meaning                                                                                |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `from.name`       | `--from-step-name`  | Exact step name from the app, including an empty name. Required for selective restart. |
| `from.count`      | `--from-step-count` | Positive, one-based occurrence of that name and type. Defaults to `1`.                 |
| `from.type`       | `--from-step-type`  | `do`, `sleep` or `waitForEvent`. Defaults to `do`; `sleep` also selects `sleepUntil`.  |

To request a new approval, restart the event-wait step and then send a fresh event:

```sh
widefleet workflows restart process example-restart-1 \
  --from-step-name approval --from-step-type waitForEvent
widefleet workflows send-event process example-restart-1 approval --payload approval.json
widefleet workflows status process example-restart-1
```

In the app's **Workflows** section, choose **Restart from a step**, enter the instance ID and step name, and select the occurrence and type.

For HTTP management, send the same selector to `POST /api/v1/apps/{appId}/workflows` with the `Idempotency-Key` header described above:

```json
{
  "request": {
    "action": "restart",
    "workflow": "process",
    "id": "example-restart-1",
    "from": { "name": "finish", "count": 1, "type": "do" }
  }
}
```

The selected step and every later step in the execution history run again, including later steps in parallel branches. Earlier results are reused, and the instance keeps its original input and app version. Buffered, unconsumed events are cleared, so a restarted event wait needs a fresh event.

Step options are evaluated again. A restarted `sleep` waits its full duration again. For `sleepUntil`, an expression such as `Date.now() + 60000` produces a new future deadline, while a fixed deadline returned by an earlier retained step stays the same and fails if it has passed. Ordinary recovery after a crash keeps the deadlines already scheduled.

If the target is missing, the request fails and the instance stays as it was. Check the exact name, type and occurrence against the path that ran; steps in a branch that did not run cannot be selected. Use `status` to follow the new run, and delete the instance with `widefleet workflows delete process example-restart-1` when you no longer need its results.

## Write replay-safe Workflows

Widefleet records each step's result and replays `run()` to continue an instance after a wait, retry, crash or restart. Replay matches each step by its name, type and occurrence count. Follow these rules so replay finds the recorded results:

1. Put side effects such as database writes, emails and external API calls inside `step.do`, and make them safe to repeat. A step can run again after a failed attempt, a crash or a selective restart.
2. Treat code outside steps as repeatable. It runs again on every replay, including short `fetch` calls and `setTimeout` waits between steps.
3. Give parallel branches distinct step names when the order in which they start can vary.
4. When you reuse a step name, call those steps in the same order on every run.
5. Call steps from `run()` or its branches, not from inside a `step.do` callback.
6. Reach the next step call within 60 seconds. Put longer work, direct app service calls, Node APIs and manual stream reads inside `step.do`, and use `step.sleep` for durable delays.

## Supported step API

Workflows support `step.do`, `step.sleep`, `step.sleepUntil` and `step.waitForEvent`, including parallel branches, repeated step names, retry policies with a static delay (a number or duration string) and optional backoff, the callback's attempt context and `NonRetryableError`. Schedule `sleepUntil` with a deadline in the future.

Widefleet rejects options outside this set at the step call: function-valued retry delays, step rollback handlers and rollback on termination. Workflow scheduling and facets are not part of this interface. Step parameters and results must fit the runtime's value-size limits, and internal bookkeeping uses part of that space.
