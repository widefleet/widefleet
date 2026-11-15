<script lang="ts">
  import {
    getAppServices,
    disconnectApp,
    setServiceAccess,
    connectApp,
  } from "#lib/services.remote";
  import { getApps } from "#lib/apps.remote";
  import ServiceConnectionForm from "#shadcn/components/ServiceConnectionForm.svelte";
  import { getAppConnections } from "#lib/connections.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const applications = $derived(await getApps());

  const catalog = $derived(await getAppServices());

  const connections = $derived(data.app ? await getAppConnections({ appId: data.app.id }) : null);

  const grants = $derived({
    ...connections?.activeConnections,
    ...connections?.connections.grants,
  });

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
      Connect an API to your app or request approval from an administrator.
    </p>
  </div>
  <a class="block text-sm underline underline-offset-4" href="/services/requests"
    >Connection requests</a
  >
  <form method="GET" action="/services" class="flex flex-wrap items-end gap-3">
    <div class="min-w-0 flex-1 space-y-2">
      <Label for="consumer-app">Connect to your app</Label>
      <NativeSelect id="consumer-app" class="w-full" name="app" required value={data.app?.id ?? ""}>
        <option value="">Select an app you manage</option>
        {#each applications.apps as app (app.id)}<option value={app.id}>{app.displayName}</option
          >{/each}
      </NativeSelect>
    </div>
    <Button type="submit" variant="outline">Select app</Button>
  </form>
  {#if data.app}<a class="block text-sm underline" href={`/apps/${data.app.id}/connections`}
      >Back to {data.app.displayName}</a
    >{/if}
  <Input aria-label="Search app APIs" placeholder="Search apps" bind:value={search} />
  <div class="divide-y rounded-lg border">
    {#each entries as entry (entry.appId)}<div class="space-y-2 p-4">
        <h2 class="font-medium">{entry.displayName}</h2>
        <p class="text-muted-foreground text-sm">{entry.slug}</p>
        <p class="text-sm">Available entrypoints: <code>{entry.entrypoints.join(", ")}</code></p>
        <p class="text-muted-foreground text-sm">
          {entry.accessMode === "organization"
            ? "Available to everyone in this organization"
            : "Administrator approval required"}
        </p>
        <a class="block text-sm underline underline-offset-4" href={`/services/${entry.appId}`}
          >View API documentation</a
        >
        {#if data.app}<ServiceConnectionForm
            appId={data.app.id}
            {entry}
            admin={catalog.admin}
          />{/if}
        {#if catalog.admin}
          {@const access = setServiceAccess.for(entry.appId)}
          <details class="pt-2 text-sm" open={Boolean(access.fields.allIssues()?.length)}>
            <summary class="cursor-pointer">Manage availability</summary>
            <form {...access} class="mt-3 space-y-3">
              <OrganizationField field={access.fields.organizationId} />
              <input {...access.fields.appId.as("hidden", entry.appId)} />
              <Label for={`availability-${entry.appId}`}>Who can connect this API?</Label>
              <NativeSelect
                id={`availability-${entry.appId}`}
                {...access.fields.accessMode.as("select", entry.accessMode)}
              >
                <option value="approval_required">Administrator approval required</option>
                <option value="organization">Everyone in this organization</option>
              </NativeSelect>
              <p class="text-muted-foreground">
                Existing connections are kept. Members can only connect apps they manage.
              </p>
              <FormIssues issues={access.fields.allIssues()} />
              <Button type="submit" variant="outline" disabled={access.pending > 0}
                >Save availability</Button
              >
            </form>
          </details>
        {/if}
      </div>
    {:else}<p class="text-muted-foreground p-4 text-sm">
        No apps with published APIs match your search.
      </p>{/each}
  </div>
  {#if data.app && connections}
    {#each Object.entries(grants) as [binding, grant] (binding)}
      {@const removal = disconnectApp.for(binding)}
      {@const removing = !connections.connections.grants[binding]}
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
          disabled={removal.pending > 0 ||
            (removing && connections.connections.state === "pending")}
          >{removing
            ? connections.connections.state === "failed"
              ? "Retry disconnection"
              : "Removal pending"
            : "Disconnect"}</Button
        >
      </form>
      {#if !removing && connections.connections.state === "failed"}
        {@const retry = connectApp.for(`retry-${binding}`)}
        <form {...retry} class="space-y-2">
          <OrganizationField field={retry.fields.organizationId} />
          <input {...retry.fields.appId.as("hidden", data.app.id)} />
          <input {...retry.fields.targetApp.as("hidden", grant.app)} />
          <input {...retry.fields.entrypoint.as("hidden", grant.entrypoint)} />
          <input {...retry.fields.binding.as("hidden", binding)} />
          <FormIssues issues={retry.fields.allIssues()} />
          <Button type="submit" variant="outline" disabled={retry.pending > 0}
            >Retry connection {binding}</Button
          >
        </form>
      {/if}
    {/each}
  {/if}
</div>
