<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppAudience from "#shadcn/components/AppAudience.svelte";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const app = getAppContext();
</script>

<AppAudience appId={app.data.app.id} initialSaved={route.accessSaved} />
