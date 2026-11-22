<script lang="ts">
  import { getAppServices, getConnectionRequests, getServiceListApp } from "#lib/services.remote";
  import AppApisHeader from "#shadcn/components/AppApisHeader.svelte";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import Plug from "@lucide/svelte/icons/plug";
  import Search from "@lucide/svelte/icons/search";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { page } from "$app/state";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const selection = $derived({ organizationId: workspace.organizationId });

  // Start the queries together; consecutive awaits would request them one after another.
  const [catalog, requests, app] = $derived(
    await Promise.all([
      getAppServices(selection),
      getConnectionRequests(selection),
      getServiceListApp({ ...selection, app: page.url.searchParams.get("app") }),
    ]),
  );

  let search = $state("");

  const available = $derived(catalog.entries.filter((entry) => entry.appId !== app?.id));

  const entries = $derived(
    available.filter((entry) =>
      `${entry.displayName} ${entry.slug}`
        .toLocaleLowerCase("en")
        .includes(search.toLocaleLowerCase("en")),
    ),
  );

  const groups = $derived(
    [
      { mode: "organization", label: "Available to your organization" },
      { mode: "approval_required", label: "Requires administrator approval" },
    ].flatMap((group) => {
      const members = entries.filter((entry) => entry.accessMode === group.mode);

      return members.length ? [{ ...group, entries: members }] : [];
    }),
  );

  const context = $derived(app ? `?app=${app.id}` : "");
</script>

<svelte:head><title>App APIs · Widefleet</title></svelte:head>
{#if app}<a
    href={workspace.path(`/apps/${app.id}/connections`)}
    class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
    ><ArrowLeft class="size-3.5" />Back to {app.displayName}</a
  >{/if}
<AppApisHeader
  active="catalog"
  apis={available.length}
  pending={requests.entries.filter((entry) => entry.status === "pending").length}
  query={context}
  {...app ? { description: `Choose an API for ${app.displayName}.` } : {}}
>
  <div class="relative w-full sm:w-60">
    <Search class="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-3.5" />
    <Input
      aria-label="Search app APIs"
      type="search"
      placeholder="Search APIs …"
      class="h-9 pl-8"
      bind:value={search}
    />
  </div>
</AppApisHeader>
{#each groups as group (group.mode)}
  <section aria-label={group.label} class="mt-6">
    <h2 class="text-muted-foreground flex items-center gap-2 px-3 pb-2 text-xs font-medium">
      <span
        class={`size-1.5 rounded-full ${group.mode === "organization" ? "bg-emerald-500" : "bg-amber-500"}`}
        aria-hidden="true"
      ></span>{group.label}<span class="tabular-nums">{group.entries.length}</span>
    </h2>
    <ul class="divide-y border-y">
      {#each group.entries as entry (entry.appId)}
        <li
          class="group hover:bg-muted/40 relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_auto]"
        >
          <div class="flex min-w-0 items-center gap-3">
            <span
              class="text-muted-foreground grid size-6 shrink-0 place-items-center"
              aria-hidden="true"><Plug class="size-4" /></span
            >
            <div class="min-w-0">
              <a
                href={workspace.path(`/services/${entry.appId}`)}
                class="block truncate text-sm font-medium after:absolute after:inset-0"
                >{entry.displayName}<span class="sr-only"> API documentation</span></a
              >
              <p class="text-muted-foreground truncate font-mono text-xs">{entry.slug}</p>
            </div>
          </div>
          <p
            class="text-muted-foreground hidden truncate font-mono text-xs sm:block"
            title={entry.entrypoints.join(", ")}
          >
            {entry.entrypoints.join(" · ")}
          </p>
          <Button
            variant="outline"
            size="sm"
            class="relative z-10 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
            href={workspace.path(`/services/${entry.appId}/connect${context}`)}
            >Connect<span class="sr-only"> to {entry.displayName}</span></Button
          >
        </li>
      {/each}
    </ul>
  </section>
{:else}
  <p class="text-muted-foreground py-10 text-center text-sm">
    {available.length === 0
      ? "No apps publish an API yet. APIs appear here after their provider app is deployed."
      : "No APIs match your search."}
  </p>
{/each}
