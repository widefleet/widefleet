<script lang="ts">
  import { getApps } from "#lib/apps.remote";
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

  const catalog = $derived(await getCatalog({ organizationId: workspace.organizationId }));

  // Connectors have their place on My connections, so Home shows the other apps.
  const apps = $derived(catalog.filter((app) => !app.connector));

  // A card names the published connectors its app works with.
  const connectors = $derived(
    new Map(catalog.flatMap((app) => (app.connector ? [[app.id, app] as const] : []))),
  );

  const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

  // A tile leads the people who manage its app to the pages for managing it.
  const managed = $derived(
    new Set(
      (await getApps({ organizationId: workspace.organizationId })).apps.map((app) => app.id),
    ),
  );

  const search = $derived((page.url.searchParams.get("q") ?? "").trim().slice(0, 200));

  const matches = $derived(
    apps.filter((app) =>
      `${app.displayName} ${app.description ?? ""} ${app.hostname}`
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
      description="Apps appear here once their owners show them on Home."
      >{#snippet icon()}<LayoutGrid />{/snippet}<Button
        href={workspace.path("/apps")}
        variant="outline">Go to Manage</Button
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
        {@const used = app.uses.flatMap((id) => connectors.get(id) ?? [])}
        <li>
          <div
            class="hover:border-primary/30 hover:bg-muted/30 relative flex h-full flex-col rounded-xl border transition-colors"
          >
            <div class="flex-1 p-5">
              <div class="flex items-center gap-3">
                <span
                  class="bg-primary/5 text-primary grid size-10 shrink-0 place-items-center rounded-xl"
                  ><AppIcon appId={app.id} deploymentId={app.activeDeploymentId} /></span
                >
                <a
                  href={workspace.path(`${managed.has(app.id) ? "" : "/catalog"}/apps/${app.id}`)}
                  class="text-sm font-semibold wrap-anywhere after:absolute after:inset-0 after:rounded-xl"
                  >{app.displayName}</a
                >
              </div>
              <p class="text-muted-foreground mt-3 line-clamp-2 text-xs/5 wrap-anywhere">
                {app.description ?? app.hostname}
              </p>
            </div>
            <!-- Every card ends with the same bar, so the way into the app has a fixed place. -->
            <div class="flex min-h-12 items-center justify-between gap-3 border-t py-1.5 pr-2 pl-5">
              {#if used.length}
                <span
                  role="img"
                  aria-label={`Uses ${names.format(used.map((connector) => connector.displayName))}`}
                  class="flex items-center"
                >
                  {#each used.slice(0, 4) as connector (connector.id)}
                    <!-- The icon is drawn for a larger box, so it is scaled into the circle. -->
                    <span
                      title={connector.displayName}
                      class="bg-background ring-background -ml-1.5 grid size-6 place-items-center overflow-hidden rounded-full border ring-2 first:ml-0"
                      ><span class="scale-[0.6]"
                        ><AppIcon
                          appId={connector.id}
                          deploymentId={connector.activeDeploymentId}
                        /></span
                      ></span
                    >
                  {/each}
                  {#if used.length > 4}<span class="text-muted-foreground ml-1.5 text-xs"
                      >+{used.length - 4}</span
                    >{/if}
                </span>
              {/if}
              <Button
                href={app.url}
                target="_blank"
                rel="noreferrer"
                variant="ghost"
                size="sm"
                class="relative z-10 ml-auto"
                >Open app<ArrowUpRight /><span class="sr-only">
                  {app.displayName} in a new tab</span
                ></Button
              >
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
