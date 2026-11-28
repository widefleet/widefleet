<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { updateClientContext } from "#lib/analytics-client";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";
  import { onMount } from "svelte";
  import { startBrowserReporting } from "#lib/reporting-client";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster } from "@platform/ui/sonner";

  // The status endpoint needs a session, so signed-out pages skip it instead of logging a 401.
  onMount(() => startBrowserReporting(() => data.signedIn));

  // Every signed-in page identifies the person; workspace pages add the organization in Workspace.svelte.
  $effect(() => {
    updateClientContext({
      user: page.data.analyticsUser ?? null,
      organization: null,
      role: null,
      analytics: page.data.analytics ?? null,
    });
  });

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<ModeWatcher defaultMode="system" />
<Toaster />
{@render children()}
