<script lang="ts">
  import { getApps } from "#lib/apps.remote";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Badge } from "@platform/ui/badge";
  import Plus from "@lucide/svelte/icons/plus";
  import Search from "@lucide/svelte/icons/search";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import TemplateList from "#shadcn/components/TemplateList.svelte";
  import AppIcon from "#shadcn/components/AppIcon.svelte";
  import AppStatus from "#shadcn/components/AppStatus.svelte";
  import type { PageData } from "./$types";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let { data: route }: { data: PageData } = $props();

  const data = $derived(await getApps({ organizationId: workspace.organizationId }));

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

<svelte:head><title>My apps · Widefleet</title></svelte:head>
<PageHeading title="My apps">
  <Button href={workspace.path("/services")} variant="outline">App APIs</Button>
  {#if data.principal.creator}<Button href={workspace.path("/apps/new")}><Plus />Create app</Button
    >{/if}
</PageHeading>
{#if data.apps.length === 0}
  <!-- Without apps of their own, members start from the templates. -->
  {#if !data.principal.creator}<p class="text-muted-foreground mt-2 text-sm">
      Apps you can manage appear here. Ask an app owner for access.
    </p>{/if}
  <div class="mt-8"><TemplateList /></div>
{:else}
  <div class="mt-8 flex flex-wrap items-center justify-between gap-4 border-b pb-4">
    <nav aria-label="Filter apps" class="bg-muted/60 flex items-center gap-1 rounded-lg p-1">
      {#each filters as filter (filter.value)}<a
          href={workspace.path(
            `/apps?${new URLSearchParams({ filter: filter.value, q: route.search })}`,
          )}
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
  {#if apps.length === 0}
    <EmptyState title="No matching apps" description="Try another search or show all apps again.">
      {#snippet icon()}<Search />{/snippet}<Button href={workspace.path("/apps")} variant="outline"
        >Reset filters</Button
      >
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
          class="group relative grid grid-cols-[minmax(0,1fr)_24px] items-center gap-4 rounded-md px-3 py-3 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_190px_24px]"
        >
          <div class="flex min-w-0 items-center gap-3">
            <AppIcon
              appId={app.id}
              deploymentId={app.web && app.state === "active" ? app.activeDeploymentId : null}
            />
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <a
                  href={workspace.path(`/apps/${app.id}`)}
                  class="truncate text-sm font-medium after:absolute after:inset-0 after:rounded-md"
                  >{app.displayName}</a
                >{#if app.parentId}<Badge variant="secondary" class="text-[10px]">Preview</Badge
                  >{/if}
              </div>
              <p class="text-muted-foreground mt-1 truncate text-xs">
                {app.web ? app.hostname : "Service only"}
              </p>
              <div class="mt-2 sm:hidden"><AppStatus state={app.state} /></div>
            </div>
          </div>
          <div class="hidden sm:block"><AppStatus state={app.state} /></div>
          <ChevronRight class="text-muted-foreground/50 group-hover:text-foreground size-4" />
        </li>
      {/each}
    </ul>
  {/if}
  <a
    href={workspace.path("/catalog/templates")}
    class="text-muted-foreground hover:text-foreground mt-6 inline-flex items-center gap-1 text-xs"
    >Start another app from a template<ArrowRight class="size-3" /></a
  >
{/if}
