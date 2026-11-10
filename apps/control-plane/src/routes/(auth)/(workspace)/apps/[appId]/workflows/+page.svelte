<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import Workflows from "#shadcn/Workflows.svelte";

  const app = getAppContext();
</script>

{#if app.data.app.state !== "deleting"}<Workflows appId={app.data.app.id} />{/if}
