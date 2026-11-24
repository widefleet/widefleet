<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppAudience from "#shadcn/components/AppAudience.svelte";
  import AppHomeListing from "#shadcn/components/AppHomeListing.svelte";

  const app = getAppContext();
</script>

<AppAudience appId={app.data.app.id} />
<!-- A preview is never listed. -->
{#if !app.data.app.parentId}<AppHomeListing data={app.data} search={app.search} />{/if}
