<script lang="ts">
  import { onDestroy } from "svelte";
  import { workflowOperation, workflowRequest } from "@platform/contracts";
  import { z } from "zod";
  import { getWorkflows, getWorkflowOperation, manageWorkflow } from "#lib/workflows.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import { Textarea } from "#shadcn/components/ui/textarea/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";

  let { appId }: { appId: string } = $props();

  const definitions = $derived(await getWorkflows({ appId }));

  let workflow = $state("");

  let action = $state("list");

  let id = $state("");

  let payload = $state("{}");

  let eventType = $state("");

  let cursor = $state("");

  let busy = $state(false);

  let message = $state("");

  let operation = $state<z.infer<typeof workflowOperation> | null>(null);

  let requestId = $state<string | null>(null);

  let fingerprint = "";

  let disposed = false;

  onDestroy(() => {
    disposed = true;
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy) return;
    busy = true;
    message = "";
    operation = null;

    try {
      const name = workflow || definitions[0]?.workflow_name;

      if (action === "create" && !id) id = crypto.randomUUID();
      let input;

      if (action === "list") input = { action, workflow: name, cursor: cursor || undefined };
      else if (action === "create")
        input = { action, workflow: name, id, params: z.json().parse(JSON.parse(payload)) };
      else if (action === "sendEvent")
        input = {
          action,
          workflow: name,
          id,
          event: { type: eventType, payload: z.json().parse(JSON.parse(payload)) },
        };
      else input = { action, workflow: name, id };
      const request = workflowRequest.parse(input);
      const next = JSON.stringify(request);

      if (!requestId || fingerprint !== next) {
        requestId = crypto.randomUUID();
        fingerprint = next;
      }

      operation = await manageWorkflow({ appId, requestId, request });

      while (!disposed && (operation.state === "queued" || operation.state === "running")) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (disposed) break;
        const query = getWorkflowOperation({ appId, jobId: operation.id });
        await query.refresh();
        operation = await query;
      }

      if (operation.state === "succeeded" || operation.state === "failed") requestId = null;
    } catch (error) {
      message = error instanceof Error ? error.message : "The workflow request failed.";
    } finally {
      busy = false;
    }
  };
</script>

<section
  id="workflows"
  aria-labelledby="workflows-heading"
  class="max-w-2xl space-y-5 rounded-xl border p-5 sm:p-6"
>
  <h2 id="workflows-heading" class="text-base font-semibold">Workflows</h2>
  {#if definitions.length === 0}<p class="text-muted-foreground text-sm leading-6">
      No workflows are defined in the current deployment. You can still manage instances from
      previous versions by entering their workflow name.
    </p>
  {:else}<ul class="text-muted-foreground space-y-2 text-sm wrap-anywhere">
      {#each definitions as definition (definition.name)}<li>
          <strong class="text-foreground">{definition.workflow_name}</strong> ·
          <code>{definition.name}</code>
          · {definition.class_name}
        </li>{/each}
    </ul>{/if}
  <form onsubmit={submit} class="space-y-4">
    <div class="space-y-2">
      <Label for="workflow-name">Workflow name</Label><Input
        id="workflow-name"
        bind:value={workflow}
        placeholder={definitions[0]?.workflow_name ?? "Workflow name"}
        list="workflow-names"
        required={definitions.length === 0}
        disabled={busy}
      />
    </div>
    <datalist id="workflow-names"
      >{#each definitions as definition (definition.name)}<option value={definition.workflow_name}
        ></option>{/each}</datalist
    >
    <div class="space-y-2">
      <Label for="workflow-action">Action</Label><NativeSelect
        id="workflow-action"
        bind:value={action}
        disabled={busy}
        class="w-full"
      >
        <option value="list">List instances</option><option value="status">Show status</option
        ><option value="create">Start instance</option>
        <option value="sendEvent">Send event</option><option value="pause">Pause</option><option
          value="resume">Resume</option
        >
        <option value="restart">Restart from the beginning</option><option value="terminate"
          >Terminate</option
        ><option value="delete">Delete instance</option>
      </NativeSelect>
    </div>
    {#if action !== "list"}<div class="space-y-2">
        <Label for="workflow-instance">Instance ID</Label><Input
          id="workflow-instance"
          bind:value={id}
          required={action !== "create"}
          placeholder={action === "create" ? "Generated automatically" : "Instance ID"}
          disabled={busy}
        />
      </div>
    {:else}<div class="space-y-2">
        <Label for="workflow-cursor">Page cursor (optional)</Label><Input
          id="workflow-cursor"
          bind:value={cursor}
          disabled={busy}
        />
      </div>{/if}
    {#if action === "sendEvent"}<div class="space-y-2">
        <Label for="workflow-event">Event type</Label><Input
          id="workflow-event"
          bind:value={eventType}
          required
          disabled={busy}
        />
      </div>{/if}
    {#if action === "sendEvent" || action === "create"}<div class="space-y-2">
        <Label for="workflow-payload"
          >{action === "create" ? "Parameters (JSON)" : "Event data (JSON)"}</Label
        ><Textarea
          id="workflow-payload"
          bind:value={payload}
          rows={5}
          required
          disabled={busy}
          class="font-mono"
        />
      </div>{/if}
    {#if action === "restart"}<Feedback>Previously completed steps will run again.</Feedback>{/if}
    {#if action === "delete"}<Feedback
        >The instance and its stored steps will be permanently deleted.</Feedback
      >{/if}
    <Button type="submit" disabled={busy}>{busy ? "Processing request …" : "Run action"}</Button>
  </form>
  {#if message}<Feedback kind="error">{message}</Feedback>
    {#if requestId}<p class="text-muted-foreground text-xs leading-6 wrap-anywhere">
        This request has not been confirmed. Submitting the same inputs again checks the same
        operation: <code>{requestId}</code>.
      </p>{/if}
  {/if}
  {#if operation}
    <Feedback
      kind={operation.state === "failed"
        ? "error"
        : operation.state === "succeeded"
          ? "success"
          : "info"}
      >{operation.state === "queued"
        ? "Requested — waiting for the agent."
        : operation.state === "running"
          ? "The agent is processing this request."
          : operation.state === "failed"
            ? "The request failed."
            : "Request completed."}</Feedback
    >
    <p class="text-muted-foreground text-xs wrap-anywhere">
      Operation: <code>{operation.id}</code>
    </p>
    {#if operation.state === "failed"}<Feedback kind="error">{operation.message}</Feedback>{/if}
    {#if operation.state === "succeeded" && operation.result !== null}<pre
        class="bg-muted overflow-x-auto rounded-lg p-4 text-xs">{JSON.stringify(
          operation.result,
          null,
          2,
        )}</pre>{/if}
  {/if}
</section>
