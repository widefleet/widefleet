<script lang="ts">
  import Layers2 from "@lucide/svelte/icons/layers-2";
  import IconImage from "./IconImage.svelte";

  let { appId, deploymentId }: { appId: string; deploymentId: string | null } = $props();

  // The deployment in the URL lets browsers keep the icon until the app is deployed again.
  const source = $derived(
    deploymentId ? `/api/v1/apps/${appId}/icon?deployment=${deploymentId}` : null,
  );
</script>

<IconImage {source}><Layers2 class="size-4" /></IconImage>
