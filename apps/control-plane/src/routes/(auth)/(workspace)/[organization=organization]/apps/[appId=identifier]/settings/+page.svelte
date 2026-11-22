<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppSettings from "#shadcn/components/AppSettings.svelte";

  const app = getAppContext();
</script>

{#if app.data.app.state !== "deleting"}<AppSettings data={app.data} search={app.search} />{/if}
