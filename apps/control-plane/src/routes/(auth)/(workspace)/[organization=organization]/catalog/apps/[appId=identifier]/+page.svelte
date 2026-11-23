<script lang="ts">
  import { getCatalog } from "#lib/catalog.remote";
  import AppIcon from "#shadcn/components/AppIcon.svelte";
  import { getWorkspaceContext } from "#lib/workspace-context";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import { Button } from "@platform/ui/button";
  import { error } from "@sveltejs/kit";
  import type { PageProps } from "./$types";

  const workspace = getWorkspaceContext();

  let { params }: PageProps = $props();

  // A published app's page for the people who use it: what it is for and the way into it.
  const app = $derived(
    (await getCatalog({ organizationId: workspace.organizationId })).find(
      (entry) => entry.id === params.appId,
    ) ?? error(404, "App not found"),
  );
</script>

<svelte:head><title>{app.displayName} · Widefleet</title></svelte:head>
<a
  href={workspace.path("/")}
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />Home</a
>
<div class="flex flex-wrap items-center justify-between gap-4">
  <div class="flex min-w-0 items-center gap-4">
    <span class="bg-primary/5 text-primary grid size-12 shrink-0 place-items-center rounded-xl"
      ><AppIcon appId={app.id} deploymentId={app.activeDeploymentId} /></span
    >
    <div class="min-w-0">
      <h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">{app.displayName}</h1>
      {#if app.description}<p class="mt-1 text-sm wrap-anywhere">{app.description}</p>{/if}
    </div>
  </div>
  <Button href={app.url} target="_blank" rel="noreferrer">Open app<ArrowUpRight /></Button>
</div>
