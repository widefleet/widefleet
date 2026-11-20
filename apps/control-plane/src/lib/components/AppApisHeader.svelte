<script lang="ts">
  import type { Snippet } from "svelte";
  import PageHeading from "./PageHeading.svelte";

  let {
    active,
    apis,
    pending,
    description,
    query = "",
    children,
  }: {
    active: "catalog" | "requests";
    apis: number;
    pending: number;
    description?: string;
    query?: string;
    children?: Snippet;
  } = $props();

  const views = $derived([
    { id: "catalog", label: "Catalog", href: `/services${query}`, count: apis },
    { id: "requests", label: "Requests", href: "/services/requests", count: pending },
  ]);
</script>

<PageHeading title="App APIs" {...description ? { description } : {}} />
<div class="mt-8 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
  <nav aria-label="App API views" class="bg-muted/60 flex items-center gap-1 rounded-lg p-1">
    {#each views as view (view.id)}<a
        href={view.href}
        aria-current={active === view.id ? "page" : undefined}
        class={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium ${active === view.id ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
        >{view.label}{#if view.id === "catalog"}<span
            class="text-muted-foreground ml-2 tabular-nums">{view.count}</span
          >{:else if view.count > 0}<span
            class="ml-2 inline-flex items-center gap-1 text-amber-600 tabular-nums dark:text-amber-400"
            ><span class="size-1.5 rounded-full bg-current" aria-hidden="true"
            ></span>{view.count}<span class="sr-only"> awaiting approval</span></span
          >{/if}</a
      >{/each}
  </nav>
  {#if children}{@render children()}{/if}
</div>
