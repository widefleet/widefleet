<script lang="ts">
  import { getCatalog } from "#lib/catalog.remote";
  import { page } from "$app/state";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import AppIcon from "#shadcn/components/AppIcon.svelte";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import Search from "@lucide/svelte/icons/search";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const apps = $derived(await getCatalog({ organizationId: workspace.organizationId }));

  const search = $derived((page.url.searchParams.get("q") ?? "").trim().slice(0, 200));

  const matches = $derived(
    apps.filter((app) =>
      `${app.displayName} ${app.hostname}`
        .toLocaleLowerCase("en")
        .includes(search.toLocaleLowerCase("en")),
    ),
  );
</script>

<svelte:head><title>Home · Widefleet</title></svelte:head>
<PageHeading title="Home" />
<div class="mt-8 flex flex-wrap items-center justify-between gap-4 border-b pb-5">
  <p class="text-muted-foreground text-xs">
    {apps.length}
    {apps.length === 1 ? "app" : "apps"} in your organization
  </p>
  <form method="GET" role="search" class="flex w-full gap-2 sm:w-auto">
    <Input
      type="search"
      name="q"
      value={search}
      maxlength={200}
      placeholder="Search apps …"
      aria-label="Search apps"
      class="sm:w-64"
    />
    <Button type="submit" variant="outline"
      ><Search /><span class="sr-only sm:not-sr-only">Search</span></Button
    >
  </form>
</div>
<section aria-label="Apps in your organization">
  {#if apps.length === 0}
    <EmptyState
      title="No apps to discover yet"
      description="Apps appear here once their owners publish them to the catalog."
      >{#snippet icon()}<LayoutGrid />{/snippet}<Button
        href={workspace.path("/apps")}
        variant="outline">Go to My apps</Button
      ></EmptyState
    >
  {:else if matches.length === 0}
    <EmptyState title="No matching apps" description="Try another search or show all apps again."
      >{#snippet icon()}<Search />{/snippet}<Button href={workspace.path("/")} variant="outline"
        >Reset search</Button
      ></EmptyState
    >
  {:else}
    <ul class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each matches as app (app.id)}
        <li>
          <a
            href={app.url}
            target="_blank"
            rel="noreferrer"
            class="hover:border-primary/30 hover:bg-muted/30 group flex h-full flex-col rounded-xl border p-5 transition-colors"
          >
            <div class="mb-5 flex items-center justify-between">
              <span class="bg-primary/5 text-primary grid size-10 place-items-center rounded-xl"
                ><AppIcon appId={app.id} deploymentId={app.activeDeploymentId} /></span
              ><ArrowUpRight class="text-muted-foreground group-hover:text-primary size-4" />
            </div>
            <span class="text-sm font-semibold wrap-anywhere">{app.displayName}</span>
            <span class="text-muted-foreground mt-2 text-xs wrap-anywhere">{app.hostname}</span>
            <span class="sr-only">Opens in a new tab</span>
          </a>
        </li>
      {/each}
    </ul>
    <p class="text-muted-foreground mt-6 text-xs leading-6">
      Sign in with your company account. Some apps may require membership in specific groups.
    </p>
  {/if}
</section>
