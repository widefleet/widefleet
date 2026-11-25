<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { updateClientContext } from "#lib/analytics-client";
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { startBrowserReporting } from "#lib/reporting-client";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "@platform/ui/sonner";

  onMount(startBrowserReporting);

  // Every signed-in page identifies the person; workspace pages add the organization in Workspace.svelte.
  $effect(() => {
    updateClientContext({
      user: page.data.analyticsUser ?? null,
      organization: null,
      role: null,
      analytics: page.data.analytics ?? null,
    });
  });

  let { children }: { children: Snippet } = $props();
</script>

<ModeWatcher defaultMode="system" />
<Toaster />
{@render children()}
