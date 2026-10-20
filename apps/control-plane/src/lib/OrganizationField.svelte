<script lang="ts">
  import type { RemoteFormField } from "$app/server";
  import { getWorkspaceContext } from "#lib/workspace-context";

  let { field }: { field: RemoteFormField<string> } = $props();

  const workspace = getWorkspaceContext();
</script>

<input {...field.as("hidden", workspace.organizationId)} />
