<script lang="ts">
  import "../app.css";
  import { page } from "$app/state";
  import { updateClientContext } from "#lib/analytics-client";
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { startBrowserReporting } from "#lib/reporting-client";
  import { ModeWatcher } from "mode-watcher";

  onMount(startBrowserReporting);

  $effect(() => {
    const principal = page.data.principal;

    const organization = page.data.organizations?.find(
      (entry) => entry.id === principal?.application.organizationId,
    );

    updateClientContext({
      user: principal ? { id: principal.id } : null,
      organization: organization ? { id: organization.id, name: organization.name } : null,
      role: principal?.role ?? null,
      url: page.url.href,
      analytics: page.data.analytics ?? null,
    });
  });

  let { children }: { children: Snippet } = $props();
</script>

<ModeWatcher defaultMode="system" />
{@render children()}
