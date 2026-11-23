<script lang="ts">
  import { page } from "$app/state";
  import { getCatalog } from "#lib/catalog.remote";
  import { getUserConnections, getUserConnectionStatus } from "#lib/user-connections.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import UserConnectionRow from "#shadcn/components/UserConnectionRow.svelte";
  import UserConnectionEntry from "#shadcn/components/UserConnectionEntry.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import { Button } from "@platform/ui/button";
  import Link2 from "@lucide/svelte/icons/link-2";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const result = $derived(await getUserConnections({ organizationId: workspace.organizationId }));

  const connections = $derived(result.connections);

  // A published connector's name leads to its page.
  const published = $derived(
    new Set(
      (await getCatalog({ organizationId: workspace.organizationId })).map((entry) => entry.id),
    ),
  );

  const pageOf = (appId: string) =>
    published.has(appId) ? workspace.path(`/catalog/apps/${appId}`) : undefined;

  const statuses = $derived(
    connections.map((connection) =>
      getUserConnectionStatus({
        organizationId: workspace.organizationId,
        appId: connection.appId,
      }),
    ),
  );

  // A connector whose status check finds no personal connection drops out of the list.
  const visible = $derived(connections.filter((_, index) => statuses[index]?.current !== null));

  // Once every check has ended, the connectors sort into those with an account and those
  // without one. Until then they stay in one list, so no row changes its place twice. A
  // connector whose check failed is in neither group: its account may well be connected.
  const entries = $derived(statuses.flatMap((status) => (status.current ? [status.current] : [])));

  const groups = $derived(
    [
      {
        id: "connected",
        title: "Connected",
        entries: entries.filter((entry) => entry.status?.connection === "connected"),
      },
      {
        id: "open",
        title: "Not connected yet",
        entries: entries.filter((entry) => entry.status?.connection === "disconnected"),
      },
      {
        id: "unknown",
        title: "Could not check",
        entries: entries.filter((entry) => !entry.status),
      },
    ].filter((group) => group.entries.length),
  );

  let refreshing = $state(false);

  let refreshFailed = $state(false);

  const refresh = async (event: MouseEvent) => {
    event.preventDefault();
    refreshing = true;
    refreshFailed = false;

    try {
      await Promise.all([
        getUserConnections({ organizationId: workspace.organizationId }).refresh(),
        ...statuses.map((status) => status.refresh()),
      ]);
    } catch {
      refreshFailed = true;
    } finally {
      refreshing = false;
    }
  };
</script>

<svelte:head><title>My connections · Widefleet</title></svelte:head>
<div class="max-w-2xl space-y-6">
  <PageHeading title="My connections" />
  {#if page.url.searchParams.has("connectionError")}
    <p role="alert" class="text-destructive text-sm">
      Authorization was not completed. Check the status below and try again when you are ready.
    </p>
  {/if}
  {#if refreshFailed}<p role="alert" class="text-destructive text-sm">
      Could not refresh. The last checked status is still shown.
    </p>{/if}
  {#if result.error?.kind === "refused"}
    <p role="alert" class="text-sm">{result.error.message}</p>
  {:else if result.error}
    <p role="alert" class="text-sm">
      Could not load your connections. Your saved accounts have not changed.
    </p>
  {:else if visible.length === 0}
    <EmptyState
      title="No personal connections available"
      description="Connectors will appear here after your administrator makes them available to you."
      >{#snippet icon()}<Link2 />{/snippet}</EmptyState
    >
  {:else if entries.length === visible.length}
    {#each groups as group (group.id)}
      <section aria-labelledby={`connections-${group.id}`}>
        <h2
          id={`connections-${group.id}`}
          class="text-muted-foreground text-[11px] font-medium tracking-wider uppercase"
        >
          {group.title}
        </h2>
        <ul class="divide-border/60 divide-y">
          {#each group.entries as connection (connection.appId)}
            <UserConnectionRow
              {connection}
              href={pageOf(connection.appId)}
              showHostname={visible.some(
                (other) =>
                  other.appId !== connection.appId && other.displayName === connection.displayName,
              )}
              confirmDisconnect={page.url.searchParams.get("disconnect") === connection.appId}
            />
          {/each}
        </ul>
      </section>
    {/each}
  {:else}
    <ul class="divide-border/60 divide-y">
      {#each visible as connection (connection.appId)}
        {@const showHostname = visible.some(
          (other) =>
            other.appId !== connection.appId && other.displayName === connection.displayName,
        )}
        {@const confirmDisconnect = page.url.searchParams.get("disconnect") === connection.appId}
        <!-- Each status runs the connector's code, so rows show while their status loads. -->
        <svelte:boundary>
          <UserConnectionEntry record={connection} {showHostname} {confirmDisconnect} />
          {#snippet pending()}
            <UserConnectionRow
              connection={{ ...connection, status: null, unavailable: false }}
              {showHostname}
              {confirmDisconnect}
              checking
            />
          {/snippet}
        </svelte:boundary>
      {/each}
    </ul>
  {/if}
  {#if refreshFailed || result.error?.kind === "unavailable" || statuses.some((status) => status.current?.unavailable)}
    <Button
      href={workspace.path("/connections")}
      onclick={refresh}
      variant="outline"
      size="sm"
      disabled={refreshing}
    >
      {refreshing ? "Retrying…" : "Try again"}
    </Button>
  {/if}
</div>
