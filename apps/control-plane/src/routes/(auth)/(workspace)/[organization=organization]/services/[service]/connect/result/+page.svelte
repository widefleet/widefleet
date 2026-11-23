<script lang="ts">
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import { Button } from "@platform/ui/button";
  import { page } from "$app/state";
  import { getConnectionResult } from "#lib/services.remote";
  import type { PageProps } from "./$types";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let { params }: PageProps = $props();

  const data = $derived(
    await getConnectionResult({
      organizationId: workspace.organizationId,
      service: params.service,
      app: page.url.searchParams.get("app"),
      binding: page.url.searchParams.get("binding"),
    }),
  );

  const state = $derived(data.connections.connections.state);

  const titles = {
    saved: "Connection saved",
    pending: "Connection is activating",
    active: "Connection active",
    failed: "Connection needs attention",
  };

  const descriptions = {
    saved: "Deploy your app to activate this connection.",
    pending:
      "Your connection has been saved. Activation is still in progress; check your app’s connections for the result.",
    active: "Your app can now use this API through the binding below.",
    failed:
      "The connection was saved, but activation failed. Open your app’s connections to inspect the error and retry.",
  };
</script>

<svelte:head><title>{titles[state]} · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-8">
  <PageHeading title={titles[state]} description={descriptions[state]} />
  <p class="text-sm leading-6 wrap-anywhere">
    <strong>{data.app.displayName}</strong> → <strong>{data.serviceName}</strong>
  </p>
  <div class="space-y-2">
    <p class="text-muted-foreground text-sm">Use this binding in your app</p>
    <code class="bg-muted block rounded-md p-4 wrap-anywhere">env.{data.binding}</code>
  </div>
  <Button href={workspace.path(`/apps/${data.app.id}/connections`)}>View app connections</Button>
</div>
