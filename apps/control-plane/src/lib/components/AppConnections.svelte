<script lang="ts">
  import type { app as appContract, appResource, capabilityState } from "@platform/contracts";
  import type { z } from "zod";
  import { getAppConnections } from "#lib/connections.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import * as Accordion from "#shadcn/components/ui/accordion/index.js";
  import Globe from "@lucide/svelte/icons/globe";
  import Box from "@lucide/svelte/icons/box";
  import Plug from "@lucide/svelte/icons/plug";
  import Database from "@lucide/svelte/icons/database";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import AppStatus from "./AppStatus.svelte";
  import Feedback from "./Feedback.svelte";

  let { app }: { app: z.infer<typeof appContract> } = $props();

  const request = $derived(getAppConnections({ appId: app.id }));

  const connections = $derived(
    await request.catch((cause: unknown) => {
      if (request.error && request.error.status >= 500 && request.current) return request.current;
      throw cause;
    }),
  );

  const names = $derived(
    [
      ...new Set([
        ...Object.keys(connections.connections.grants),
        ...Object.keys(connections.activeConnections ?? {}),
      ]),
    ].sort(),
  );

  const labels = {
    active: "Active",
    saved: "Saved",
    pending: "Pending",
    failed: "Failed",
  } satisfies Record<z.infer<typeof capabilityState>["state"], string>;

  const resourceLabels = {
    d1: "Database",
    r2_bucket: "Object storage",
    kv_namespace: "Key-value storage",
    queue: "Queue",
    workflow: "Workflow",
    assets: "Static assets",
  } satisfies Record<z.infer<typeof appResource>["type"], string>;

  const binding = (name: string) => {
    const desired = connections.connections.grants[name];
    const active = connections.activeConnections?.[name];

    const unchanged = Boolean(
      desired && active && desired.app === active.app && desired.entrypoint === active.entrypoint,
    );

    return {
      desired,
      active,
      unchanged,
      state: unchanged ? ("active" as const) : connections.connections.state,
    };
  };
</script>

{#snippet status(state: z.infer<typeof capabilityState>["state"], removing = false)}
  <Badge variant="outline" class="shrink-0 gap-1.5 font-normal">
    <span
      aria-hidden="true"
      class={`size-1.5 rounded-full ${state === "active" ? "bg-emerald-500" : state === "failed" ? "bg-destructive" : state === "pending" ? "bg-amber-500" : "bg-muted-foreground/50"}`}
    ></span>
    {removing ? (state === "failed" ? "Removal failed" : "Removal pending") : labels[state]}
  </Badge>
{/snippet}

<section aria-labelledby="connections-heading" class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h2 id="connections-heading" class="text-base font-semibold">Connections</h2>
      <p class="text-muted-foreground mt-1 text-sm">
        The app connections and resources used by this app.
      </p>
    </div>
    <Button variant="outline" size="sm" href={`/services?app=${app.id}`}
      ><Plug />Browse app APIs</Button
    >
  </div>
  {#if request.error}<Feedback kind="error"
      >Could not refresh connections. The last loaded data remains visible. Choose Refresh app to
      try again.</Feedback
    >{/if}
  {#if connections.connections.error}<Feedback kind="error"
      >Connection changes could not be activated: {connections.connections.error} Previously active connections
      remain in use.</Feedback
    >{/if}
  {#if connections.connections.state === "saved" && names.length}<Feedback
      >Connections are saved. They become active with the app’s first successful deployment.</Feedback
    >{:else if connections.connections.state === "pending"}<Feedback
      >Connection changes are pending. Active connections remain in use until activation succeeds.</Feedback
    >{/if}
  {#if connections.activeConnections === null}<Feedback
      >The active connections could not be confirmed. Saved bindings are shown below.</Feedback
    >{/if}

  <div class="bg-muted/20 rounded-xl border p-4 sm:p-6">
    <div
      class="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,0.85fr)_minmax(0,1.3fr)]"
    >
      <div class="relative self-start xl:mt-6">
        <div class="bg-background rounded-lg border px-4 py-4 shadow-xs">
          <div class="mb-3 flex items-center gap-2 text-sm font-medium">
            <Globe class="text-muted-foreground size-4" />Domain
          </div>
          {#if !app.web}<p class="text-muted-foreground text-xs">Service only · no web access</p>
          {:else if app.activeDeploymentId}
            <a
              class="text-muted-foreground hover:text-foreground flex items-start gap-2 text-xs"
              href={app.url}
              target="_blank"
              rel="noreferrer"
              ><span class="min-w-0 wrap-anywhere">{app.hostname}</span><ArrowUpRight
                class="mt-0.5 size-3 shrink-0"
              /><span class="sr-only">Opens in a new tab</span></a
            >
          {:else}<p class="text-muted-foreground text-xs wrap-anywhere">{app.hostname}</p>
            <p class="text-muted-foreground mt-2 text-xs">Available after deployment</p>{/if}
        </div>
        <span
          aria-hidden="true"
          class="text-muted-foreground absolute top-10 -right-8 hidden w-8 items-center xl:flex"
          ><span class="bg-border h-px flex-1"></span><ArrowRight class="-ml-1 size-3" /></span
        >
      </div>

      <div class="relative self-start xl:mt-6">
        <div class="bg-background rounded-lg border px-4 py-4 shadow-xs">
          <div class="mb-3 flex items-start gap-2 text-sm font-semibold">
            <Box class="text-muted-foreground mt-0.5 size-4 shrink-0" /><span
              class="min-w-0 wrap-anywhere">{app.displayName}</span
            >
          </div>
          <AppStatus state={app.state} />
          <p class="text-muted-foreground mt-3 text-xs">
            {app.parentId ? "Preview app" : "Application"}
          </p>
        </div>
        <span
          aria-hidden="true"
          class="text-muted-foreground absolute top-10 -right-8 hidden w-8 items-center xl:flex"
          ><span class="bg-border h-px flex-1"></span><ArrowRight class="-ml-1 size-3" /></span
        >
      </div>

      <div class="min-w-0 space-y-4">
        <div class="bg-background rounded-lg border shadow-xs">
          <div class="flex items-center gap-2 border-b px-4 py-4 text-sm font-medium">
            <Plug class="text-muted-foreground size-4" />App connections<Badge
              variant="secondary"
              class="ml-auto font-normal">{names.length}</Badge
            >
          </div>
          {#if names.length === 0}
            <div class="px-4 py-6">
              <p class="text-sm">
                {connections.activeConnections === null
                  ? "No saved connections"
                  : "No apps connected"}
              </p>
              <p class="text-muted-foreground mt-2 text-xs leading-5">
                Browse the catalog and ask an administrator to connect an integration.
              </p>
            </div>
          {:else}
            <Accordion.Root type="multiple" class="px-4">
              {#each names as name (name)}
                {@const item = binding(name)}
                <Accordion.Item value={name}>
                  <Accordion.Trigger class="items-center gap-2 py-4 hover:no-underline">
                    <span class="min-w-0 flex-1"
                      ><code class="block text-xs wrap-anywhere">{name}</code><span
                        class="text-muted-foreground mt-1 block text-xs font-normal wrap-anywhere"
                        >{item.desired?.app ?? item.active?.app}</span
                      ></span
                    >
                    {@render status(item.state, !item.desired)}
                  </Accordion.Trigger>
                  <Accordion.Content>
                    <dl class="space-y-2 text-xs">
                      {#if item.desired}<div class="flex justify-between gap-3">
                          <dt class="text-muted-foreground">Entrypoint</dt>
                          <dd class="min-w-0 text-right font-mono wrap-anywhere">
                            {item.desired.entrypoint}
                          </dd>
                        </div>{/if}
                      <div class="flex justify-between gap-3">
                        <dt class="text-muted-foreground">Use in code</dt>
                        <dd class="min-w-0 text-right font-mono wrap-anywhere">env.{name}</dd>
                      </div>
                      {#if item.active && !item.unchanged}<div class="border-t pt-3">
                          <dt class="text-muted-foreground mb-1">Currently active</dt>
                          <dd class="wrap-anywhere">
                            {item.active.app} · {item.active.entrypoint}
                          </dd>
                        </div>{/if}
                    </dl>
                  </Accordion.Content>
                </Accordion.Item>
              {/each}
            </Accordion.Root>
          {/if}
        </div>

        <div class="bg-background rounded-lg border shadow-xs">
          <div class="flex items-center gap-2 border-b px-4 py-4 text-sm font-medium">
            <Database class="text-muted-foreground size-4" />Resources<Badge
              variant="secondary"
              class="ml-auto font-normal">{connections.resources.length}</Badge
            >
          </div>
          {#if connections.resources.length === 0}
            <p class="text-muted-foreground px-4 py-6 text-xs leading-5">
              {connections.deploymentId
                ? "No resource bindings in the active deployment."
                : "Resources appear after the first successful deployment."}
            </p>
          {:else}
            <Accordion.Root type="multiple" class="px-4">
              {#each connections.resources as resource (resource.binding)}
                <Accordion.Item value={resource.binding}>
                  <Accordion.Trigger class="items-center gap-2 py-4 hover:no-underline">
                    <span class="min-w-0 flex-1"
                      ><span class="text-muted-foreground mb-1 block text-xs font-normal"
                        >{resourceLabels[resource.type]}</span
                      ><code class="block text-xs wrap-anywhere">{resource.binding}</code></span
                    >
                    {@render status("active")}
                  </Accordion.Trigger>
                  <Accordion.Content
                    ><dl class="space-y-2 text-xs">
                      <div>
                        <dt class="text-muted-foreground mb-1">Target</dt>
                        <dd class="wrap-anywhere">{resource.target}</dd>
                      </div>
                      {#if resource.databaseId}
                        <div>
                          <dt class="text-muted-foreground mb-1">Database ID</dt>
                          <dd class="font-mono wrap-anywhere">{resource.databaseId}</dd>
                        </div>
                      {/if}
                      <div>
                        <dt class="text-muted-foreground mb-1">Use in code</dt>
                        <dd class="font-mono wrap-anywhere">env.{resource.binding}</dd>
                      </div>
                    </dl></Accordion.Content
                  >
                </Accordion.Item>
              {/each}
            </Accordion.Root>
            <p class="text-muted-foreground border-t px-4 py-3 text-[11px]">
              From the active deployment
            </p>
          {/if}
        </div>
      </div>
    </div>
  </div>
</section>
