<script lang="ts">
  import { page } from "$app/state";
  import { getUserConnections, finishConnectionOnboarding } from "#lib/user-connections.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import UserConnectionRow from "#shadcn/components/UserConnectionRow.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import { Button } from "@platform/ui/button";
  import Link2 from "@lucide/svelte/icons/link-2";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

  const result = $derived(await getUserConnections());

  const onboarding = $derived(page.url.searchParams.get("onboarding") === "1");

  const path = $derived(onboarding ? "/connections?onboarding=1" : "/connections");

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
<div class="max-w-3xl space-y-6">
  <PageHeading
    title={onboarding ? "Connect your accounts" : "My connections"}
    description={onboarding
      ? "Your organization has set up these connectors. Connect the accounts you want to use, or skip this step and come back later."
      : "Your personal accounts for the connectors your organization has made available."}
  >
    <Button href={path} onclick={refresh} variant="outline" size="sm" disabled={refreshing}
      ><RefreshCw class={refreshing ? "animate-spin motion-reduce:animate-none" : ""} />{refreshing
        ? "Refreshing…"
        : "Refresh"}</Button
    >
  </PageHeading>
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
      href={`/sign-in?${new URLSearchParams({ next: path, ...(organization ? { organization: organization.slug } : {}) })}`}
      >Sign in</Button
    >
  {:else if result.error}
    <p role="alert" class="text-sm">
      Connections are temporarily unavailable. Try refreshing. Your saved connections have not
      changed.
    </p>
  {:else if result.connections.length === 0}
    <EmptyState
      title="No personal connections available"
      description="Connectors will appear here after your administrator makes them available to you."
      >{#snippet icon()}<Link2 />{/snippet}</EmptyState
    >
  {:else}
    <ul class="divide-y border-y">
      {#each result.connections as connection (connection.appId)}
        <UserConnectionRow
          {connection}
          {onboarding}
          confirmDisconnect={page.url.searchParams.get("disconnect") === connection.appId}
        />
      {/each}
    </ul>
  {/if}
  {#if onboarding}
    <form {...finishConnectionOnboarding} class="flex flex-wrap items-center gap-4">
      <OrganizationField field={finishConnectionOnboarding.fields.organizationId} />
      <Button type="submit" disabled={finishConnectionOnboarding.pending > 0}
        >Continue to apps</Button
      >
      <p class="text-muted-foreground text-sm">
        You can manage these accounts later in My connections.
      </p>
    </form>
  {/if}
</div>
