<script lang="ts">
  import { getAppServices, connectApp, disconnectApp } from "#lib/services.remote";
  import { getAppConnections } from "#lib/connections.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const catalog = $derived(await getAppServices());

  const connections = $derived(data.app ? await getAppConnections({ appId: data.app.id }) : null);

  let search = $state("");

  const entries = $derived(
    catalog.entries.filter(
      (entry) =>
        entry.appId !== data.app?.id &&
        `${entry.displayName} ${entry.slug}`.toLowerCase().includes(search.toLowerCase()),
    ),
  );
</script>

<svelte:head><title>App APIs · Widefleet</title></svelte:head>
<div class="max-w-3xl space-y-6">
  <div>
    <h1 class="text-xl font-semibold">App APIs</h1>
    <p class="text-muted-foreground mt-2 text-sm">
      Apps can share selected APIs with other apps. An administrator grants each connection.
    </p>
  </div>
  {#if data.app}<a class="text-sm underline" href={`/apps/${data.app.id}/connections`}
      >Back to {data.app.displayName}</a
    >{/if}
  <Input aria-label="Search app APIs" placeholder="Search apps" bind:value={search} />
  <div class="divide-y rounded-lg border">
    {#each entries as entry (entry.appId)}<div class="space-y-2 p-4">
        <h2 class="font-medium">{entry.displayName}</h2>
        <p class="text-muted-foreground text-sm">{entry.slug}</p>
        <p class="text-sm">Available entrypoints: <code>{entry.entrypoints.join(", ")}</code></p>
      </div>
    {:else}<p class="text-muted-foreground p-4 text-sm">
        No apps with published APIs match your search.
      </p>{/each}
  </div>
  {#if data.app && connections && catalog.admin}
    {#each Object.entries(connections.connections.grants) as [binding, grant] (binding)}
      {@const removal = disconnectApp.for(binding)}
      <form {...removal} class="flex items-center justify-between gap-4 rounded-lg border p-4">
        <OrganizationField field={removal.fields.organizationId} />
        <input {...removal.fields.appId.as("hidden", data.app.id)} /><input
          {...removal.fields.binding.as("hidden", binding)}
        />
        <span class="text-sm"
          ><code>{binding}</code> → {catalog.entries.find((entry) => entry.appId === grant.app)
            ?.displayName ?? grant.app} · {grant.entrypoint}</span
        >
        <FormIssues issues={removal.fields.allIssues()} /><Button
          variant="outline"
          type="submit"
          disabled={removal.pending > 0}>Disconnect</Button
        >
      </form>
    {/each}
    <form {...connectApp} class="space-y-4 rounded-lg border p-4">
      <OrganizationField field={connectApp.fields.organizationId} /><input
        {...connectApp.fields.appId.as("hidden", data.app.id)}
      />
      <h2 class="font-medium">Connect an app</h2>
      <FormIssues issues={connectApp.fields.allIssues()} />
      <div class="space-y-2">
        <Label for="target">Target app</Label><NativeSelect
          id="target"
          {...connectApp.fields.targetApp.as("select")}
          required
          ><option value="">Select app</option>{#each entries as entry (entry.appId)}<option
              value={entry.appId}>{entry.displayName}</option
            >{/each}</NativeSelect
        >
      </div>
      <div class="space-y-2">
        <Label for="entrypoint">Entrypoint</Label><Input
          id="entrypoint"
          {...connectApp.fields.entrypoint.as("text")}
          placeholder="CustomerReader"
          required
        />
      </div>
      <div class="space-y-2">
        <Label for="binding">Binding name in your code</Label><Input
          id="binding"
          {...connectApp.fields.binding.as("text")}
          placeholder="ERP"
          required
        />
      </div>
      <Button type="submit" disabled={connectApp.pending > 0}>Save connection</Button>
    </form>
  {/if}
</div>
