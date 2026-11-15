<script lang="ts">
  import type { serviceCatalogEntry } from "@platform/contracts";
  import type { z } from "zod";
  import { connectApp, requestAppConnection } from "#lib/services.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";

  let {
    appId,
    entry,
    admin,
  }: { appId: string; entry: z.infer<typeof serviceCatalogEntry>; admin: boolean } = $props();

  const approval = $derived(!admin && entry.accessMode === "approval_required");

  const action = $derived((approval ? requestAppConnection : connectApp).for(entry.appId));
</script>

<details class="pt-2 text-sm" open={Boolean(action.fields.allIssues()?.length)}>
  <summary class="cursor-pointer font-medium"
    >{approval ? "Request connection" : "Connect API"}</summary
  >
  <form {...action} class="mt-3 space-y-4">
    <OrganizationField field={action.fields.organizationId} />
    <input {...action.fields.appId.as("hidden", appId)} />
    <input {...action.fields.targetApp.as("hidden", entry.appId)} />
    <div class="space-y-2">
      <Label for={`entrypoint-${entry.appId}`}>API entrypoint</Label>
      <NativeSelect
        id={`entrypoint-${entry.appId}`}
        {...action.fields.entrypoint.as("select")}
        required
      >
        {#each entry.entrypoints as entrypoint (entrypoint)}<option value={entrypoint}
            >{entrypoint}</option
          >{/each}
      </NativeSelect>
    </div>
    <div class="space-y-2">
      <Label for={`binding-${entry.appId}`}>Binding name in your code</Label>
      <Input
        id={`binding-${entry.appId}`}
        {...action.fields.binding.as("text")}
        placeholder="ERP"
        required
      />
    </div>
    <FormIssues issues={action.fields.allIssues()} />
    <Button type="submit" disabled={action.pending > 0}
      >{approval ? "Submit request" : "Connect"}</Button
    >
  </form>
</details>
