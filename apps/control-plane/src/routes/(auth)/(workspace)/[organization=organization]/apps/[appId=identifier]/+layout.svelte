<script lang="ts">
  import { page } from "$app/state";
  import { getAppDetails, getAppSource } from "#lib/apps.remote";
  import { getAppConnections } from "#lib/connections.remote";
  import { getAppServices, getServiceDescription } from "#lib/services.remote";
  import type { manageWorkflow } from "#lib/workflows.remote";
  import { Button } from "@platform/ui/button";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import InlineText from "#shadcn/components/InlineText.svelte";
  import { getAppListing, renameApp, setAppDescription } from "#lib/catalog.remote";
  import { appDescriptionLength, appNameLength } from "@platform/contracts";
  import AppStatus from "#shadcn/components/AppStatus.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { onMount } from "svelte";
  import { setAppContext } from "#lib/app-context";
  import type { LayoutProps } from "./$types";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let { params, children }: LayoutProps = $props();

  const route = $derived({
    appId: params.appId,
    search: (page.url.searchParams.get("q") ?? "").trim().slice(0, 200),
  });

  const details = $derived(
    getAppDetails({
      organizationId: workspace.organizationId,
      appId: route.appId,
      search: route.search,
    }),
  );

  // The tab is the route segment after the app, such as `deployments` or `access`.
  const activeTab = $derived.by(() => {
    const segments = page.route.id?.split("/") ?? [];

    return segments[segments.indexOf("[appId=identifier]") + 1] ?? "overview";
  });

  let refreshing = $state(false);

  const rollbackRequests = $state<Record<string, { requestId: string; pending: boolean }>>({});

  const workflowOperations = $state<Record<string, Awaited<ReturnType<typeof manageWorkflow>>>>({});

  const submitRollback = async ({ submit }: { submit: () => Promise<boolean> }) => {
    // Keep the submitted key until the rollback succeeds, so a retry is recognized as the same request.
    rollbackRequests[route.appId] ??= {
      requestId: data.requestId,
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

  const refresh = async (manual = true) => {
    if (refreshing) return;
    refreshing = true;

    try {
      const deployed = data.app.activeDeploymentId;
      await details.refresh();

      // A deployment can change the apps this one calls, which its page shows.
      if (activeTab === "overview")
        await getAppListing({
          organizationId: workspace.organizationId,
          appId: route.appId,
        }).refresh();

      // The saved code comes from the Git host, so the timer asks again only after a deployment.
      if (
        activeTab === "deployments" &&
        data.source.supported &&
        (manual || details.current?.app.activeDeploymentId !== deployed)
      )
        await getAppSource({
          organizationId: workspace.organizationId,
          appId: route.appId,
        }).refresh();

      // A deployment can add the app to the organization's APIs or change what it exposes.
      if (activeTab === "api")
        await Promise.all([
          getAppServices({ organizationId: workspace.organizationId }).refresh(),
          getServiceDescription({
            organizationId: workspace.organizationId,
            service: route.appId,
          }).refresh(),
        ]);

      if (activeTab === "connections")
        await getAppConnections({
          organizationId: workspace.organizationId,
          appId: route.appId,
        }).refresh();
    } catch {
      // The query exposes the failure without replacing the last confirmed result.
    } finally {
      refreshing = false;
    }
  };

  onMount(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
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
      return rollbackRequests[route.appId]?.requestId ?? data.requestId;
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

  const tabs = $derived([
    { id: "overview", label: "Overview" },
    { id: "deployments", label: "Deployments" },
    // An app without an API or workflows has no section for them.
    ...(data.features.api ? [{ id: "api", label: "API" }] : []),
    { id: "connections", label: "Connections" },
    ...(data.features.workflows ? [{ id: "workflows", label: "Workflows" }] : []),
    { id: "access", label: "Access" },
    { id: "settings", label: "Settings" },
  ]);
</script>

<svelte:head><title>{data.app.displayName} · Widefleet</title></svelte:head>
<a
  href={workspace.path("/apps")}
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />Manage</a
>
<div class="flex flex-wrap items-center justify-between gap-4">
  <div class="flex items-center gap-2">
    <span class="text-muted-foreground text-[11px] font-medium tracking-wider uppercase"
      >{data.app.parentId ? "Preview" : data.features.connector ? "Connector" : "App"}</span
    ><AppStatus state={data.app.state} />
  </div>
  <div class="flex items-center gap-2">
    <Button
      variant="outline"
      size="icon"
      aria-label="Refresh app"
      title="Refresh"
      disabled={refreshing}
      onclick={() => refresh()}
      ><RefreshCw class={refreshing ? "animate-spin motion-reduce:animate-none" : ""} /></Button
    >{#if data.app.state === "active" && data.app.web}<Button
        href={data.app.url}
        target="_blank"
        rel="noreferrer">Open app<ArrowUpRight /></Button
      >{/if}
  </div>
</div>
<!-- Below the actions, so editing the name or the description does not move them. -->
<div class="mt-1">
  <InlineText
    form={renameApp}
    appId={data.app.id}
    search={route.search}
    value={data.app.displayName}
    label="Name"
    maxlength={appNameLength}
    heading
  />
</div>
{#if !data.app.parentId}<InlineText
    form={setAppDescription}
    appId={data.app.id}
    search={route.search}
    value={data.app.description ?? ""}
    label="Description"
    maxlength={appDescriptionLength}
    empty="Add a description"
  />{/if}
<p class="text-muted-foreground mt-2 text-sm wrap-anywhere">{data.app.hostname}</p>
<nav class="mt-7 mb-8 flex gap-5 overflow-x-auto border-b sm:gap-7" aria-label="App sections">
  {#each tabs as tab (tab.id)}<a
      href={workspace.path(`/apps/${data.app.id}${tab.id === "overview" ? "" : `/${tab.id}`}`)}
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
    >This app and its previews are being deleted. Cleanup continues in the background.</Feedback
  >{/if}

<!-- Children read the context, so wait for the current app's details during SSR too. -->
{#if data.app.id === route.appId}
  {#key route.appId}
    {@render children()}
  {/key}
{/if}
