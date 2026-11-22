<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { updateClientContext } from "#lib/analytics-client";
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { startBrowserReporting } from "#lib/reporting-client";
  import { ModeWatcher } from "mode-watcher";

  onMount(startBrowserReporting);

  // Signed-in workspace pages identify the member; see Workspace.svelte.
  $effect(() => {
    updateClientContext({
      user: null,
      organization: null,
      role: null,
      analytics: page.data.analytics ?? null,
    });
  });

  let { children }: { children: Snippet } = $props();
</script>

<ModeWatcher defaultMode="system" />
{@render children()}
