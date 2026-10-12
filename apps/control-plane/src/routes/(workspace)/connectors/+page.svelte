<script lang="ts">
  import { getConnectorCatalog, getAppConnections } from "#lib/connectors.remote";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import * as Accordion from "#shadcn/components/ui/accordion/index.js";
  import Plug from "@lucide/svelte/icons/plug";
  import Search from "@lucide/svelte/icons/search";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const catalogRequest = getConnectorCatalog();

  const catalog = $derived(
    await catalogRequest.catch((cause: unknown) => {
      if (catalogRequest.error && catalogRequest.error.status >= 500 && catalogRequest.current)
        return catalogRequest.current;
      throw cause;
    }),
  );

  const connectionRequest = $derived(data.app ? getAppConnections({ appId: data.app.id }) : null);

  const connections = $derived(
    await connectionRequest?.catch((cause: unknown) => {
      if (
        connectionRequest?.error &&
        connectionRequest.error.status >= 500 &&
        connectionRequest.current
      )
        return connectionRequest.current;
      throw cause;
    }),
  );

  let search = $state("");

  let refreshing = $state(false);

  const refresh = async () => {
    refreshing = true;

    try {
      await Promise.all([catalogRequest.refresh(), connectionRequest?.refresh()]);
    } catch {
      // Query errors keep the last confirmed data visible with a retry action.
    } finally {
      refreshing = false;
    }
  };

  const matches = $derived(
    catalog.filter((entry) => entry.name.toLowerCase().includes(search.trim().toLowerCase())),
  );

  const usage = (name: string) => {
    if (!connections) return null;

    const active = Object.values(connections.activeConnectors ?? {}).some(
      (grant) => grant.connector === name,
    );

    const desired = Object.values(connections.connectors.grants).some(
      (grant) => grant.connector === name,
    );

    if (active) return "Connected";

    if (desired)
      return connections.connectors.state === "failed"
        ? "Connection failed"
        : connections.connectors.state === "saved"
          ? "Saved for app"
          : "Connection pending";

    return null;
  };
</script>

<svelte:head><title>Connectors · Widefleet</title></svelte:head>
{#if data.app}
  <Button href={`/apps/${data.app.id}?tab=connections`} variant="ghost" size="sm" class="mb-5 -ml-3"
    ><ArrowLeft />{data.app.displayName}</Button
  >
{/if}
<div class="flex flex-wrap items-start justify-between gap-5">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Connectors</h1>
    <p class="text-muted-foreground mt-2 max-w-xl text-sm leading-6">
      Explore the integrations offered by your organization. Ask an administrator to connect one to
      your app.
    </p>
  </div>
  <div class="flex items-center gap-3">
    <Badge variant="secondary" class="font-normal"
      >{catalog.length} {catalog.length === 1 ? "connector" : "connectors"}</Badge
    >
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh connectors"
      title="Refresh"
      disabled={refreshing}
      onclick={refresh}
      ><RefreshCw class={refreshing ? "animate-spin motion-reduce:animate-none" : ""} /></Button
    >
  </div>
</div>
{#if catalogRequest.error || connectionRequest?.error}<div class="mt-5">
    <Feedback kind="error"
      >Could not refresh connectors. The last loaded data remains visible. Choose Refresh connectors
      to try again.</Feedback
    >
  </div>{/if}
{#if data.app}<p class="mt-5 text-sm">
    Showing connections for <span class="font-medium">{data.app.displayName}</span>.
  </p>{/if}
{#if catalog.length > 0}
  <div class="relative mt-7 max-w-sm">
    <Search class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
    <Input
      aria-label="Search connectors"
      placeholder="Search connectors…"
      bind:value={search}
      class="pl-9"
    />
  </div>
{/if}
{#if catalog.length === 0}
  <div class="mt-8 rounded-xl border border-dashed px-6 py-14 text-center">
    <Plug class="text-muted-foreground mx-auto mb-4 size-7" />
    <h2 class="text-sm font-medium">No connectors yet</h2>
    <p class="text-muted-foreground mt-2 text-sm">
      Connectors appear here once an administrator deploys them.
    </p>
  </div>
{:else if matches.length === 0}
  <p class="text-muted-foreground mt-8 text-sm">No connectors match your search.</p>
{:else}
  <Accordion.Root type="multiple" class="mt-6 space-y-3">
    {#each matches as entry (entry.name)}
      {@const connection = usage(entry.name)}
      <Accordion.Item value={entry.name} class="rounded-xl border px-5 last:border-b">
        <Accordion.Trigger class="items-center gap-3 py-5 hover:no-underline">
          <span class="bg-muted grid size-9 shrink-0 place-items-center rounded-lg"
            ><Plug class="text-muted-foreground size-4" /></span
          >
          <span class="min-w-0 flex-1 wrap-anywhere">{entry.name}</span>
          <span class="flex flex-wrap justify-end gap-2">
            {#if connection}<Badge variant="secondary" class="font-normal">{connection}</Badge>{/if}
            <Badge variant="outline" class="font-normal"
              >{entry.entrypoints.length ? "Available" : "Not ready"}</Badge
            >
          </span>
        </Accordion.Trigger>
        <Accordion.Content>
          <div class="border-t pt-4 pb-1">
            {#if entry.entrypoints.length}
              <p class="text-muted-foreground mb-3 text-xs">Available entrypoints</p>
              <div class="flex flex-wrap gap-2">
                {#each entry.entrypoints as entrypoint (entrypoint)}<code
                    class="bg-muted rounded-md px-2 py-1 text-xs">{entrypoint}</code
                  >{/each}
              </div>
              <p class="text-muted-foreground mt-4 text-xs leading-5">
                An administrator selects an entrypoint and a binding name when connecting your app.
              </p>
            {:else}
              <p class="text-muted-foreground text-sm">
                No entrypoints are ready to connect. An administrator needs to complete activation.
              </p>
            {/if}
          </div>
        </Accordion.Content>
      </Accordion.Item>
    {/each}
  </Accordion.Root>
{/if}
