<script lang="ts">
  import type { z } from "zod";
  import type { userConnectionEntry } from "@platform/contracts";
  import { getUserConnectionStatus } from "#lib/user-connections.remote";
  import UserConnectionRow from "#shadcn/components/UserConnectionRow.svelte";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let {
    record,
    confirmDisconnect,
    showHostname = false,
  }: {
    record: Omit<z.infer<typeof userConnectionEntry>, "status" | "unavailable">;
    confirmDisconnect: boolean;
    showHostname?: boolean;
  } = $props();

  const entry = $derived(
    await getUserConnectionStatus({
      organizationId: workspace.organizationId,
      appId: record.appId,
    }),
  );
</script>

<!-- A connector that no longer offers personal connections drops out of the list. -->
{#if entry}<UserConnectionRow connection={entry} {confirmDisconnect} {showHostname} />{/if}
