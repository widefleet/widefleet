<script lang="ts">
  import { getApps } from "#lib/apps.remote";
  import { getCreatePrompt } from "#lib/catalog.remote";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Badge } from "@platform/ui/badge";
  import { Label } from "@platform/ui/label";
  import { Textarea } from "@platform/ui/textarea";
  import * as DropdownMenu from "@platform/ui/dropdown-menu";
  import { toast } from "@platform/ui/sonner";
  import { mergeProps } from "bits-ui";
  import Copy from "@lucide/svelte/icons/copy";
  import Plus from "@lucide/svelte/icons/plus";
  import Search from "@lucide/svelte/icons/search";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import TemplateList from "#shadcn/components/TemplateList.svelte";
  import AppIcon from "#shadcn/components/AppIcon.svelte";
  import AppStatus from "#shadcn/components/AppStatus.svelte";
  import { page } from "$app/state";
  import { z } from "zod";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const route = $derived({
    search: (page.url.searchParams.get("q") ?? "").trim().slice(0, 200),
    filter: z
      .enum(["all", "apps", "connectors"])
      .catch("all")
      .parse(page.url.searchParams.get("filter")),
  });

  const data = $derived(await getApps({ organizationId: workspace.organizationId }));

  const apps = $derived(
    data.apps.filter((app) => {
      const matches = `${app.displayName} ${app.hostname}`
        .toLocaleLowerCase("en")
        .includes(route.search.toLocaleLowerCase("en"));

      return (
        matches && (route.filter === "all" || app.connector === (route.filter === "connectors"))
      );
    }),
  );

  const createPrompt = $derived(
    await getCreatePrompt({ organizationId: workspace.organizationId }),
  );

  // Where the browser refuses to copy, the prompt appears so it can be selected by hand.
  let uncopied = $state(false);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(createPrompt);
      uncopied = false;
      toast.success("Prompt copied.", { description: "Paste it into your agent." });
    } catch {
      uncopied = true;
    }
  };

  const connectors = $derived(data.apps.filter((app) => app.connector).length);

  const filters = $derived([
    { value: "all", label: "All", count: data.apps.length },
    { value: "apps", label: "Apps", count: data.apps.length - connectors },
    { value: "connectors", label: "Connectors", count: connectors },
  ]);
</script>

<svelte:head><title>Manage · Widefleet</title></svelte:head>
<PageHeading title="Manage">
  <!-- Without apps the page itself shows the ways to start, so the button would repeat them. -->
  {#if data.principal.creator && data.apps.length > 0}
    <DropdownMenu.Root>
      <!-- A link keeps the templates reachable before hydration and without JavaScript. -->
      <DropdownMenu.Trigger>
        {#snippet child({ props })}<Button
            {...mergeProps(props, { onclick: (event: MouseEvent) => event.preventDefault() })}
            href={workspace.path("/catalog/templates")}><Plus />Create app</Button
          >{/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-72">
        <DropdownMenu.Item class="items-start gap-3 p-2.5" onSelect={copyPrompt}>
          <span class="flex-1"
            ><span class="block font-medium">Build with your agent</span><span
              class="text-muted-foreground block text-xs"
              >Copy a prompt and tell your agent what you need.</span
            ></span
          >
          <Copy class="text-muted-foreground mt-0.5" />
        </DropdownMenu.Item>
        <DropdownMenu.Item class="p-2.5">
          {#snippet child({ props })}<a {...props} href={workspace.path("/catalog/templates")}
              ><span
                ><span class="block font-medium">Start from a template</span><span
                  class="text-muted-foreground block text-xs"
                  >Choose a ready-made connector and set it up.</span
                ></span
              ></a
            >{/snippet}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</PageHeading>
{#if uncopied}
  <!-- A text area takes keyboard focus, so the prompt can be selected without a pointer. -->
  <div class="mt-6 space-y-2">
    <Label for="create-prompt">Prompt for your agent</Label>
    <Textarea
      id="create-prompt"
      readonly
      rows={4}
      value={createPrompt}
      aria-describedby="create-prompt-help"
      class="font-mono text-xs"
      onfocus={(event) => event.currentTarget.select()}
    />
    <p id="create-prompt-help" class="text-muted-foreground text-xs" role="alert">
      Copying is not available here. Select the prompt and copy it manually.
    </p>
  </div>
{/if}
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
          >{filter.label}<span class="text-muted-foreground ml-2 tabular-nums">{filter.count}</span
          ></a
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
                >{#if app.connector && route.filter === "all"}<Badge
                    variant="secondary"
                    class="text-[10px]">Connector</Badge
                  >{/if}{#if app.parentId}<Badge variant="secondary" class="text-[10px]"
                    >Preview</Badge
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
{/if}
