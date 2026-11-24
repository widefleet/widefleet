<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppConnections from "#shadcn/components/AppConnections.svelte";
  import AppSecrets from "#shadcn/components/AppSecrets.svelte";

  const app = getAppContext();
</script>

<AppConnections app={app.data.app} />
<div class="mt-10 border-t pt-8"><AppSecrets /></div>
