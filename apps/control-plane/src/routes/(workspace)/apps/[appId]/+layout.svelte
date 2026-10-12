<script lang="ts">
  import { page } from "$app/state";
  import { getAppDetails } from "#lib/apps.remote";
  import { getAppConnections } from "#lib/connectors.remote";
  import type { manageWorkflow } from "#lib/workflows.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import AppStatus from "#shadcn/components/AppStatus.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { onMount, type Snippet } from "svelte";
  import { setAppContext } from "#lib/app-context";
  import type { LayoutData } from "./$types";

  let { data: route, children }: { data: LayoutData; children: Snippet } = $props();

  const details = $derived(getAppDetails({ appId: route.appId, search: route.search }));

  const activeTab = $derived(page.url.pathname.split("/")[3] ?? "overview");

  let refreshing = $state(false);

  const rollbackRequests = $state<Record<string, { requestId: string; pending: boolean }>>({});

  const workflowOperations = $state<Record<string, Awaited<ReturnType<typeof manageWorkflow>>>>({});

  const submitRollback = async ({ submit }: { submit: () => Promise<boolean> }) => {
    rollbackRequests[route.appId] ??= {
      requestId: route.requestId,
      pending: false,
    };

    const operation = rollbackRequests[route.appId];

    if (!operation || operation.pending) return;
    operation.pending = true;

    try {
      if (await submit()) operation.requestId = crypto.randomUUID();
    } finally {
      operation.pending = false;
    }
  };

  const refreshFailed = $derived(Boolean(details.error));

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "deployments", label: "Deployments" },
    { id: "connections", label: "Connections" },
    { id: "workflows", label: "Workflows" },
    { id: "access", label: "Access" },
    { id: "settings", label: "App settings" },
  ];

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;

    try {
      await details.refresh();

      if (activeTab === "connections") await getAppConnections({ appId: route.appId }).refresh();
    } catch {
      // The query exposes the failure without replacing the last confirmed result.
    } finally {
      refreshing = false;
    }
  };

  onMount(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);

    return () => clearInterval(timer);
  });

  setAppContext({
    get data() {
      return data;
    },
    get search() {
      return route.search;
    },
    get requestId() {
      return rollbackRequests[route.appId]?.requestId ?? route.requestId;
    },
    get rollbackPending() {
      return rollbackRequests[route.appId]?.pending ?? false;
    },
    workflowOperations,
    rememberWorkflowOperation(appId, operation) {
      workflowOperations[appId] = operation;
    },
    submitRollback,
  });

  // Keep confirmed data during transient failures; permission and resource errors still surface.
  const data = $derived(
    await details.catch((cause: unknown) => {
      if (details.error && details.error.status >= 500 && details.current) return details.current;
      throw cause;
    }),
  );
</script>

<svelte:head><title>{data.app.displayName} · Widefleet</title></svelte:head>
<a
  href="/"
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />All apps</a
>
<div class="flex flex-wrap items-start justify-between gap-4">
  <div class="min-w-0">
    <div class="mb-2 flex items-center gap-2">
      <span class="text-muted-foreground text-[11px] font-medium tracking-wider uppercase"
        >{data.app.parentId ? "Preview" : "App"}</span
      ><AppStatus state={data.app.state} />
    </div>
    <h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">{data.app.displayName}</h1>
    <p class="text-muted-foreground mt-2 text-sm wrap-anywhere">{data.app.hostname}</p>
  </div>
  <div class="flex items-center gap-2">
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh app"
      title="Refresh"
      disabled={refreshing}
      onclick={refresh}
      ><RefreshCw class={refreshing ? "animate-spin motion-reduce:animate-none" : ""} /></Button
    >{#if data.app.state === "active"}<Button href={data.app.url} target="_blank" rel="noreferrer"
        >Open app<ArrowUpRight /></Button
      >{/if}
  </div>
</div>
<nav class="mt-7 mb-8 flex gap-5 overflow-x-auto border-b sm:gap-7" aria-label="App sections">
  {#each tabs as tab (tab.id)}<a
      href={`/apps/${data.app.id}${tab.id === "overview" ? "" : `/${tab.id}`}`}
      aria-current={activeTab === tab.id ? "page" : undefined}
      class={`whitespace-nowrap border-b-2 pb-3 text-xs font-medium ${activeTab === tab.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
      >{tab.label}{#if tab.id === "deployments" && data.history.length}<span
          class="text-muted-foreground ml-1.5 tabular-nums">{data.history.length}</span
        >{/if}</a
    >{/each}
</nav>
{#if refreshFailed}<div class="mb-5">
    <Feedback kind="error"
      >Could not refresh the status. The last loaded data remains visible. Check your connection or
      choose Refresh app.</Feedback
    >
  </div>{/if}
{#if data.app.state === "deleting"}<Feedback
    >This app and its published versions are being deleted. The deployment agent processes this
    request.</Feedback
  >{/if}

<!-- Children read the context, so wait for the current app's details during SSR too. -->
{#if data.app.id === route.appId}
  {#key route.appId}
    {@render children()}
  {/key}
{/if}
