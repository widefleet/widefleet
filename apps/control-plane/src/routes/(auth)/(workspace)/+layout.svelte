<script lang="ts">
  import type { Snippet } from "svelte";
  import Workspace from "#shadcn/components/Workspace.svelte";
  import { getWorkspace } from "#lib/workspace.remote";

  let { children }: { children: Snippet } = $props();

  const workspace = $derived(await getWorkspace());
</script>

<Workspace principal={workspace.principal} organizations={workspace.organizations}
  >{@render children()}</Workspace
>
