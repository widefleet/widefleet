<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { getAppContext } from "#lib/app-context";
  import { Button } from "#shadcn/components/ui/button/index.js";

  let { children }: { children: Snippet } = $props();

  const app = getAppContext();

  const management = $derived(page.url.pathname.endsWith("/management"));
</script>

{#if app.data.app.state !== "deleting"}
  <nav aria-label="Access sections" class="mb-7 flex flex-wrap gap-2">
    <Button
      href={`/apps/${app.data.app.id}/access`}
      variant={management ? "ghost" : "secondary"}
      aria-current={!management ? "page" : undefined}>App usage</Button
    >
    <Button
      href={`/apps/${app.data.app.id}/access/management`}
      variant={management ? "secondary" : "ghost"}
      aria-current={management ? "page" : undefined}>Management access</Button
    >
  </nav>
  {@render children()}
{/if}
