<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import AppDeployments from "#shadcn/components/AppDeployments.svelte";

  const app = getAppContext();
</script>

<AppDeployments
  data={app.data}
  search={app.search}
  requestId={app.requestId}
  rollbackPending={app.rollbackPending}
  submitRollback={app.submitRollback}
/>
