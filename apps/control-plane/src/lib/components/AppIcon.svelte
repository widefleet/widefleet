<script lang="ts">
  import Layers2 from "@lucide/svelte/icons/layers-2";
  import { getWorkspaceContext } from "#lib/workspace-context";
  import IconImage from "./IconImage.svelte";

  let { appId, deploymentId }: { appId: string; deploymentId: string | null } = $props();

  const workspace = getWorkspaceContext();

  // The deployment in the URL lets browsers keep the icon until the app is deployed again.
  const source = $derived(
    deploymentId ? workspace.path(`/apps/${appId}/icon?deployment=${deploymentId}`) : null,
  );
</script>

<IconImage {source}><Layers2 class="size-4" /></IconImage>
