<script lang="ts">
  import { getApps } from "#lib/apps.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import Plus from "@lucide/svelte/icons/plus";
  import Search from "@lucide/svelte/icons/search";
  import Layers2 from "@lucide/svelte/icons/layers-2";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import AppStatus from "#shadcn/components/AppStatus.svelte";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const data = $derived(await getApps());

  const apps = $derived(
    data.apps.filter((app) => {
      const matches = `${app.displayName} ${app.hostname}`
        .toLocaleLowerCase("en")
        .includes(route.search.toLocaleLowerCase("en"));

      return (
        matches &&
        (route.filter === "active"
          ? app.state === "active"
          : route.filter === "preview"
            ? Boolean(app.parentId)
            : true)
      );
    }),
  );

  const filters = [
    { value: "all", label: "All apps" },
    { value: "active", label: "Active" },
    { value: "preview", label: "Previews" },
  ];
</script>

<svelte:head><title>Apps · Widefleet</title></svelte:head>
<PageHeading title="Your apps" description="Everything that moves your team forward. In one place.">
  {#if data.principal.creator}<Button href="/apps/new"><Plus />Create app</Button>{/if}
</PageHeading>
<div class="mt-8 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
  <nav aria-label="Filter apps" class="bg-muted/60 flex items-center gap-1 rounded-lg p-1">
    {#each filters as filter (filter.value)}<a
        href={`/?${new URLSearchParams({ filter: filter.value, q: route.search })}`}
        aria-current={route.filter === filter.value ? "page" : undefined}
        class={`rounded-md px-3 py-1.5 text-xs font-medium ${route.filter === filter.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
        >{filter.label}{#if filter.value === "all"}<span
            class="text-muted-foreground ml-2 tabular-nums">{data.apps.length}</span
          >{/if}</a
      >{/each}
  </nav>
  <form method="GET" class="flex w-full items-center gap-2 sm:w-auto" role="search">
    <input type="hidden" name="filter" value={route.filter} />
    <div class="relative flex-1">
      <Search
        class="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-3.5"
      /><Input
        aria-label="Search apps"
        type="search"
        name="q"
        value={route.search}
        placeholder="Search apps …"
        maxlength={200}
        class="h-9 pl-8 sm:w-52"
      />
    </div>
    <Button type="submit" variant="outline" class="h-9">Search</Button>
  </form>
</div>
{#if data.apps.length === 0}
  <EmptyState
    title="Room for your first idea"
    description={data.principal.creator
      ? "A small utility or an everyday tool: create your first app and publish it with the CLI."
      : "Apps you can manage appear here. Ask an app admin for access."}
  >
    {#snippet icon()}<Layers2 />{/snippet}
    {#if data.principal.creator}<Button href="/apps/new"><Plus />Create your first app</Button>{/if}
  </EmptyState>
{:else if apps.length === 0}
  <EmptyState title="No matching apps" description="Try another search or show all apps again.">
    {#snippet icon()}<Search />{/snippet}<Button href="/" variant="outline">Reset filters</Button>
  </EmptyState>
{:else}
  <div
    class="text-muted-foreground hidden grid-cols-[minmax(0,1fr)_190px_24px] gap-4 px-3 pt-5 pb-2 text-[11px] font-medium sm:grid"
  >
    <span>NAME</span><span>STATUS</span><span></span>
  </div>
  <ul class="divide-y" aria-label="Apps">
    {#each apps as app (app.id)}
      <li
        class="group relative grid grid-cols-[minmax(0,1fr)_24px] items-center gap-4 rounded-md px-3 py-4 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_190px_24px]"
      >
        <div class="flex min-w-0 items-center gap-3.5">
          <span
            class={`grid size-10 shrink-0 place-items-center rounded-xl border ${app.parentId ? "bg-amber-500/5 text-amber-600 dark:text-amber-400" : "bg-primary/5 text-primary"}`}
            >{#if app.parentId}<GitBranch class="size-4" />{:else}<Layers2
                class="size-4"
              />{/if}</span
          >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <a
                href={`/apps/${app.id}`}
                class="truncate text-sm font-medium after:absolute after:inset-0 after:rounded-md"
                >{app.displayName}</a
              >{#if app.parentId}<Badge
                  variant="secondary"
                  class="hidden text-[10px] sm:inline-flex">Preview</Badge
                >{/if}
            </div>
            <p class="text-muted-foreground mt-1 truncate text-xs">{app.hostname}</p>
            <div class="mt-2 sm:hidden"><AppStatus state={app.state} /></div>
          </div>
        </div>
        <div class="hidden sm:block"><AppStatus state={app.state} /></div>
        <ChevronRight class="text-muted-foreground/50 group-hover:text-foreground size-4" />
      </li>
    {/each}
  </ul>
  <div
    class="text-muted-foreground mt-6 flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs"
  >
    <span
      >{apps.length}
      {apps.length === 1 ? "App" : "Apps"}{route.search
        ? ` matching “${route.search}”`
        : " in your workspace"}</span
    ><a href="/device" class="hover:text-foreground inline-flex items-center gap-1"
      >Work with the CLI<ArrowUpRight class="size-3" /></a
    >
  </div>
{/if}
