<script lang="ts">
  import { getTemplates } from "#lib/catalog.remote";
  import { page } from "$app/state";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import Search from "@lucide/svelte/icons/search";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";

  const search = $derived((page.url.searchParams.get("q") ?? "").trim().slice(0, 200));

  const catalog = $derived(await getTemplates({ search }));

  const matches = $derived(catalog.templates);
</script>

<svelte:head><title>App templates · Widefleet</title></svelte:head>
<div class="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
  <div>
    <h2 class="text-lg font-semibold">Start from a template</h2>
    <p class="text-muted-foreground mt-1 text-sm">
      Choose an app, then let your agent deploy and set it up.
    </p>
  </div>
  <form method="GET" role="search" class="flex w-full gap-2 sm:w-auto">
    <Input
      type="search"
      name="q"
      value={search}
      maxlength={200}
      placeholder="Search templates …"
      aria-label="Search templates"
      class="sm:w-56"
    />
    <Button type="submit" variant="outline"
      ><Search /><span class="sr-only sm:not-sr-only">Search</span></Button
    >
  </form>
</div>
{#if matches.length === 0}
  <EmptyState
    title="No matching templates"
    description="Try another search or create an app with your agent."
  >
    {#snippet icon()}<Search />{/snippet}
    <Button href="/catalog/templates" variant="outline">Reset search</Button>
  </EmptyState>
{:else}
  <ul class="divide-y">
    {#each matches as template (template.id)}
      <li>
        <a
          href={`/catalog/templates/${template.id}`}
          class="hover:bg-muted/40 group flex items-center justify-between gap-5 rounded-md px-2 py-5"
        >
          <div class="min-w-0">
            <h3 class="text-sm font-semibold">{template.name}</h3>
            <p class="text-muted-foreground mt-1 text-sm leading-6">{template.description}</p>
          </div>
          <ArrowRight class="text-muted-foreground size-4 shrink-0" />
        </a>
      </li>
    {/each}
  </ul>
{/if}
<details class="mt-8 border-t pt-6">
  <summary class="cursor-pointer text-sm font-medium"
    >App not here? Create one with your agent</summary
  >
  <p class="text-muted-foreground mt-3 mb-3 text-sm">
    Copy this prompt and tell your agent what you need.
  </p>
  <CopyValue value={catalog.createPrompt} label="Copy create app prompt" />
</details>
