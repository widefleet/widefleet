<script lang="ts">
  import TemplateList from "#shadcn/components/TemplateList.svelte";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();
</script>

<svelte:head><title>App templates · Widefleet</title></svelte:head>
<a
  href={workspace.path("/apps")}
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />Manage</a
>
<PageHeading title="Templates" />
<div class="mt-8"><TemplateList /></div>
