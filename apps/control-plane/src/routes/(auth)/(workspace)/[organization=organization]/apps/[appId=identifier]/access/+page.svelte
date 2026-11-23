<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppAudience from "#shadcn/components/AppAudience.svelte";

  const app = getAppContext();
</script>

<AppAudience appId={app.data.app.id} />
