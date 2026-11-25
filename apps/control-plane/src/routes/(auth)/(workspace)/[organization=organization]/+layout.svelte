<script lang="ts">
  import Workspace from "#shadcn/components/Workspace.svelte";
  import { getWorkspace } from "#lib/workspace.remote";
  import type { LayoutProps } from "./$types";

  let { params, children }: LayoutProps = $props();

  const workspace = $derived(await getWorkspace({ organization: params.organization }));
</script>

<Workspace
  principal={workspace.principal}
  image={workspace.image}
  organization={workspace.organization}
  organizations={workspace.organizations}>{@render children()}</Workspace
>
