<script lang="ts">
  import { appAboutLength } from "@platform/contracts";
  import { getAppListing, setAppAbout } from "#lib/catalog.remote";
  import { getUserConnections, getUserConnectionStatus } from "#lib/user-connections.remote";
  import InlineText from "#shadcn/components/InlineText.svelte";
  import Markdown from "#shadcn/components/Markdown.svelte";
  import UserConnectionEntry from "#shadcn/components/UserConnectionEntry.svelte";
  import UserConnectionRow from "#shadcn/components/UserConnectionRow.svelte";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  // What an app's page tells the people who use it. Those who manage the app see the same and
  // edit the text in place.
  let {
    appId,
    search = "",
    editable = false,
  }: { appId: string; search?: string; editable?: boolean } = $props();

  const listing = $derived(
    await getAppListing({ organizationId: workspace.organizationId, appId }),
  );

  // The reader's own accounts with the app and with the apps it calls.
  const connections = $derived(
    (await getUserConnections({ organizationId: workspace.organizationId })).connections.filter(
      (connection) => connection.appId === listing.id || listing.uses.includes(connection.appId),
    ),
  );

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
</script>

<div class="max-w-2xl space-y-8">
  {#if editable}
    <!-- The editor sets its own margins to keep the text in place, so the spacing is the wrapper's. -->
    <div>
      <InlineText
        form={setAppAbout}
        {appId}
        {search}
        value={listing.about ?? ""}
        html={listing.aboutHtml}
        label="About"
        maxlength={appAboutLength}
        empty="Add a few sentences about this app"
      />
    </div>
  {:else if listing.aboutHtml}<Markdown html={listing.aboutHtml} />{/if}
  {#if visible.length}
    <section aria-labelledby="app-connections">
      <h2 id="app-connections" class="text-sm font-semibold">Connections</h2>
      <p class="text-muted-foreground mt-1 text-xs">Your own accounts this app works with.</p>
      <ul class="divide-border/60 mt-1 divide-y">
        {#each visible as connection (connection.appId)}
          <!-- Each status runs the connector's code, so rows show while their status loads. -->
          <svelte:boundary>
            <UserConnectionEntry record={connection} confirmDisconnect={false} />
            {#snippet pending()}
              <UserConnectionRow
                connection={{ ...connection, status: null, unavailable: false }}
                confirmDisconnect={false}
                checking
              />
            {/snippet}
          </svelte:boundary>
        {/each}
      </ul>
    </section>
  {/if}
  {#if listing.owner}<p class="text-muted-foreground text-xs">
      Owned by <span class="text-foreground">{listing.owner}</span>
    </p>{/if}
</div>
