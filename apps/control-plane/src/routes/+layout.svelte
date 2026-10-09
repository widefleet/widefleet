<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { startBrowserReporting } from "#lib/reporting-client";
  import { ModeWatcher } from "mode-watcher";

  onMount(startBrowserReporting);

  let { children }: { children: Snippet } = $props();
</script>

<ModeWatcher defaultMode="light" />
{@render children()}
