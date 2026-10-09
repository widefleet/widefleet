<script lang="ts">
  import type { Snippet } from "svelte";
  import Workspace from "#shadcn/components/Workspace.svelte";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<Workspace principal={data.principal}>{@render children()}</Workspace>
