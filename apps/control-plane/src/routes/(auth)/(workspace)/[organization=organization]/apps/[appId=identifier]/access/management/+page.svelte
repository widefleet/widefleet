<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppSharing from "#shadcn/components/AppSharing.svelte";

  const app = getAppContext();
</script>

<AppSharing data={app.data} search={app.search} />
