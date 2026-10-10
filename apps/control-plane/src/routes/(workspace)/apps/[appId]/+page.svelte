<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import { getAppDetails } from "#lib/apps.remote";
  import { changeAppAccess } from "#lib/app-access.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Globe from "@lucide/svelte/icons/globe";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import AppStatus from "#shadcn/components/AppStatus.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import DeploymentStatus from "#shadcn/components/DeploymentStatus.svelte";
  import AppDeployments from "#shadcn/components/AppDeployments.svelte";
  import AppSharing from "#shadcn/components/AppSharing.svelte";
  import AppAudience, { type AccessDraft } from "#shadcn/components/AppAudience.svelte";
  import AppSettings from "#shadcn/components/AppSettings.svelte";
  import Workflows from "#shadcn/Workflows.svelte";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const details = $derived(getAppDetails({ appId: route.appId, search: route.search }));

  // Keep confirmed data during transient failures; permission and resource errors still surface.
  const data = $derived(
    await details.catch((cause: unknown) => {
      if (details.error && details.error.status >= 500 && details.current) return details.current;
      throw cause;
    }),
  );

  const latest = $derived(data.history[0]);

  const activeTab = $derived(
    route.tab === "overview" && page.url.hash === "#app-access" ? "access" : route.tab,
  );

  let refreshing = $state(false);

  let workflowAppId = $state<string | null>(null);

  // Keep the visited workflow editor mounted so tab changes preserve drafts and polling.
  $effect(() => {
    if (activeTab === "workflows") workflowAppId = route.appId;
  });

  // Tab navigation unmounts the editors, but must preserve their drafts and pending requests.
  let audienceDraft = $state<AccessDraft | undefined>(
    untrack(() => {
      const fields = changeAppAccess.for(route.appId).fields;
      const allAuthenticated = fields.allAuthenticated.value();
      const revision = fields.revision.value();

      // Unchecked checkboxes are absent from native submissions. Keep their
      // original revision after rejection instead of silently accepting a retry.
      return revision === undefined
        ? undefined
        : {
            appId: route.appId,
            allAuthenticated: allAuthenticated ?? false,
            revision: Number(revision),
          };
    }),
  );

  const rollbackRequests = $state<Record<string, { requestId: string; pending: boolean }>>({});

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
    { id: "workflows", label: "Workflows" },
    { id: "access", label: "Access" },
    { id: "settings", label: "App settings" },
  ];

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;

    try {
      await details.refresh();
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
      href={`/apps/${data.app.id}?tab=${tab.id}`}
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
{#if activeTab === "overview"}
  <div class="space-y-8">
    {#if data.app.parentId}<a
        href={`/apps/${data.app.parentId}`}
        class="bg-muted/40 hover:bg-muted/70 flex items-center gap-3 rounded-lg border p-4 text-sm"
        ><GitBranch class="text-muted-foreground size-4" /><span>Back to original app</span
        ><ArrowRight class="text-muted-foreground ml-auto size-4" /></a
      >{/if}
    {#if data.app.state !== "deleting" && !data.app.activeDeploymentId}
      <section class="overflow-hidden rounded-xl border">
        <div class="bg-primary/3 border-b px-5 py-5 sm:px-6">
          <div class="mb-3 flex items-center gap-2 text-xs font-medium text-primary">
            <CircleCheck class="size-4" />App created
          </div>
          <h2 class="text-lg font-semibold tracking-tight">Ready for your first deployment.</h2>
          <p class="text-muted-foreground mt-2 max-w-xl text-sm leading-6">
            No deployments yet. Connect your CLI and publish your project. Its status will appear
            here when it's ready.
          </p>
        </div>
        <ol class="divide-y">
          <li class="flex gap-4 p-5 sm:p-6">
            <span
              class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
              >1</span
            >
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium">Connect to your workspace</h3>
              <p class="text-muted-foreground mt-1 mb-3 text-xs leading-5">
                Run this command in your terminal and confirm the device code in your browser.
              </p>
              <CopyValue
                value={`widefleet --url '${page.url.origin}' login`}
                label="Copy sign-in command"
              />
            </div>
          </li>
          <li class="flex gap-4 p-5 sm:p-6">
            <span
              class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
              >2</span
            >
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium">Deploy your project</h3>
              <p class="text-muted-foreground mt-1 mb-3 text-xs leading-5">
                Run this from your Widefleet project directory. The command deploys directly to this
                app.
              </p>
              <CopyValue
                value={`widefleet --url '${page.url.origin}' deploy ${data.app.id}`}
                label="Copy deployment command"
              />
              <details class="mt-4">
                <summary class="text-muted-foreground text-xs">No project yet?</summary>
                <p class="text-muted-foreground mt-3 mb-2 text-xs leading-5">
                  You'll need the Widefleet CLI, Node.js and pnpm installed. Create a project in an
                  empty directory and install its dependencies.
                </p>
                <CopyValue
                  value={`widefleet init ${data.app.slug}\ncd ${data.app.slug}\npnpm install --frozen-lockfile`}
                  label="Copy project commands"
                />
              </details>
            </div>
          </li>
          <li class="flex gap-4 p-5 sm:p-6">
            <span
              class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
              >3</span
            >
            <div>
              <h3 class="text-sm font-medium">Follow progress</h3>
              <p class="text-muted-foreground mt-1 text-xs leading-5">
                The status updates automatically. Your app will be available after a successful
                deployment.
              </p>
              <Button
                href={`/apps/${data.app.id}?tab=deployments`}
                variant="link"
                class="mt-2 h-auto px-0">View deployments<ArrowRight /></Button
              >
            </div>
          </li>
        </ol>
      </section>
    {/if}
    {#if latest}<section class="rounded-xl border p-5 sm:p-6">
        <div class="mb-5 flex items-center justify-between gap-3">
          <h2 class="text-sm font-semibold">Latest deployment</h2>
          <a
            href={`/apps/${data.app.id}?tab=deployments`}
            class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >View history<ArrowRight class="size-3" /></a
          >
        </div>
        <DeploymentStatus status={latest.status} />
        <p class="text-muted-foreground mt-2 text-xs">
          {new Intl.DateTimeFormat("en-GB", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          }).format(new Date(latest.createdAt))} UTC
        </p>
        {#if latest.message}<p class="text-muted-foreground mt-4 text-sm leading-6 wrap-anywhere">
            {latest.message}
          </p>{/if}
      </section>{/if}
    <div class="grid gap-6 lg:grid-cols-2">
      <section class="min-w-0 rounded-xl border p-5 sm:p-6">
        <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold">
          <Globe class="text-muted-foreground size-4" />App address
        </h2>
        <CopyValue value={data.app.url} label="Copy app address" />
        <p class="text-muted-foreground mt-3 text-xs leading-5">
          {data.app.state === "active"
            ? "Users sign in with their company accounts."
            : "Available after the first successful deployment."}
        </p>
      </section>
      {#if data.app.state !== "deleting" && !data.app.parentId && data.roles.actions.includes("deploy")}<section
          class="rounded-xl border p-5 sm:p-6"
        >
          <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold">
            <GitBranch class="text-muted-foreground size-4" />Try ideas safely
          </h2>
          <p class="text-muted-foreground text-xs leading-6">
            Test changes in a preview with its own address and data.
          </p>
          <Button href={`/apps/new?parent=${data.app.id}`} variant="outline" class="mt-4"
            >Create preview<ArrowUpRight /></Button
          >
        </section>{/if}
    </div>
  </div>
{:else if activeTab === "deployments"}<AppDeployments
    {data}
    search={route.search}
    requestId={rollbackRequests[route.appId]?.requestId ?? route.requestId}
    rollbackPending={rollbackRequests[route.appId]?.pending ?? false}
    {submitRollback}
  />
{:else if activeTab === "access" && data.app.state !== "deleting"}
  <nav aria-label="Access sections" class="mb-7 flex flex-wrap gap-2">
    <Button
      href={`/apps/${data.app.id}?tab=access&scope=app`}
      variant={route.accessScope === "app" ? "secondary" : "ghost"}
      aria-current={route.accessScope === "app" ? "page" : undefined}>App usage</Button
    >
    <Button
      href={`/apps/${data.app.id}?tab=access&scope=management`}
      variant={route.accessScope === "management" ? "secondary" : "ghost"}
      aria-current={route.accessScope === "management" ? "page" : undefined}
      >Roles and ownership</Button
    >
  </nav>
  {#if route.accessScope === "app"}<AppAudience
      appId={data.app.id}
      initialSaved={route.accessSaved}
      bind:draft={audienceDraft}
    />{:else}<AppSharing {data} search={route.search} initialSaved={route.saved} />{/if}
{:else if activeTab === "settings" && data.app.state !== "deleting"}<AppSettings
    {data}
    search={route.search}
  />{/if}
{#if data.app.state !== "deleting" && (activeTab === "workflows" || workflowAppId === route.appId)}
  {#key route.appId}
    <div hidden={activeTab !== "workflows"}>
      <Workflows appId={route.appId} />
    </div>
  {/key}
{/if}
