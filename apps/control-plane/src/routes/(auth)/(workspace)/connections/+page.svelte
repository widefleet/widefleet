<script lang="ts">
  import { page } from "$app/state";
  import { getUserConnections } from "#lib/user-connections.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import UserConnectionRow from "#shadcn/components/UserConnectionRow.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import { Button } from "@platform/ui/button";
  import Link2 from "@lucide/svelte/icons/link-2";

  const result = $derived(await getUserConnections());

  const connections = $derived(result.connections);

  const organization = $derived(
    page.data.organizations?.find(
      (item) => item.id === page.data.principal?.application.organizationId,
    ),
  );

  let refreshing = $state(false);

  let refreshFailed = $state(false);

  const refresh = async (event: MouseEvent) => {
    event.preventDefault();
    refreshing = true;
    refreshFailed = false;

    try {
      await getUserConnections().refresh();
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
  {#if result.error === "sign_in"}
    <p class="text-sm">Sign in with your company account again to check your connections.</p>
    <Button
      href={`/sign-in?${new URLSearchParams({ next: "/connections", ...(organization ? { organization: organization.slug } : {}) })}`}
      >Sign in</Button
    >
  {:else if result.error}
    <p role="alert" class="text-sm">
      Could not load your connections. Your saved accounts have not changed.
    </p>
  {:else if connections.length === 0}
    <EmptyState
      title="No personal connections available"
      description="Connectors will appear here after your administrator makes them available to you."
      >{#snippet icon()}<Link2 />{/snippet}</EmptyState
    >
  {:else}
    <ul class="divide-border/60 divide-y">
      {#each connections as connection (connection.appId)}
        <UserConnectionRow
          {connection}
          showHostname={connections.some(
            (other) =>
              other.appId !== connection.appId && other.displayName === connection.displayName,
          )}
          confirmDisconnect={page.url.searchParams.get("disconnect") === connection.appId}
        />
      {/each}
    </ul>
  {/if}
  {#if refreshFailed || (result.error && result.error !== "sign_in") || connections.some((connection) => connection.unavailable)}
    <Button href="/connections" onclick={refresh} variant="outline" size="sm" disabled={refreshing}>
      {refreshing ? "Retrying…" : "Try again"}
    </Button>
  {/if}
</div>
