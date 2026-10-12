<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppConnections from "#shadcn/components/AppConnections.svelte";

  const app = getAppContext();
</script>

<AppConnections app={app.data.app} />
