<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppSharing from "#shadcn/components/AppSharing.svelte";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const app = getAppContext();
</script>

<AppSharing data={app.data} search={app.search} initialSaved={route.saved} />
