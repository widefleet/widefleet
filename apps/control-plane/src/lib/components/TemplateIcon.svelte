<script lang="ts">
  import LayoutTemplate from "@lucide/svelte/icons/layout-template";
  import IconImage from "./IconImage.svelte";

  let { templateId }: { templateId: string } = $props();
</script>

<IconImage source={`/api/v1/catalog/templates/${templateId}/icon`}
  ><LayoutTemplate class="size-4" /></IconImage
>
