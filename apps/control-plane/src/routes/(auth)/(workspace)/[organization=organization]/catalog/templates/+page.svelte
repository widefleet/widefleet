<script lang="ts">
  import { getApps } from "#lib/apps.remote";
  import TemplateList from "#shadcn/components/TemplateList.svelte";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const creator = $derived(
    (await getApps({ organizationId: workspace.organizationId })).principal.creator,
  );
</script>

<svelte:head><title>Create app · Widefleet</title></svelte:head>
<a
  href={workspace.path("/apps")}
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />Manage</a
>
<PageHeading title="Create app" />
<div class="mt-8"><TemplateList /></div>
{#if creator}
  <!-- For people who deploy by hand: an empty app with a name and an address. -->
  <a
    href={workspace.path("/apps/new")}
    class="text-muted-foreground hover:text-foreground mt-8 inline-flex items-center gap-1 text-xs"
    >Set name and address yourself<ArrowRight class="size-3" /></a
  >
{/if}
