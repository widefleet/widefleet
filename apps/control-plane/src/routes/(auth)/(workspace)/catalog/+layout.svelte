<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import PageHeading from "#shadcn/components/PageHeading.svelte";

  let { children }: { children: Snippet } = $props();

  const templates = $derived(page.url.pathname.startsWith("/catalog/templates"));
</script>

<PageHeading title="App catalog" />
<nav aria-label="Catalog sections" class="mt-6 mb-7 flex gap-2">
  <Button
    href="/catalog"
    variant={templates ? "ghost" : "secondary"}
    aria-current={!templates ? "page" : undefined}>Published apps</Button
  >
  <Button
    href="/catalog/templates"
    variant={templates ? "secondary" : "ghost"}
    aria-current={templates ? "page" : undefined}>Templates</Button
  >
</nav>
{@render children()}
