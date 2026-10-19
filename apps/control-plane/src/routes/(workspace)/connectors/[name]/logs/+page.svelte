<script lang="ts">
  import { connectorLogQuery, type runtimeLog } from "@platform/contracts";
  import type { z } from "zod";
  import { getConnectorLogs } from "#lib/connectors.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import * as NativeSelect from "#shadcn/components/ui/native-select/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let since = $state("1h");

  let search = $state("");

  let level = $state("");

  let version = $state("");

  let selected = $state({ since: "1h", query: "", level: "", version: "" });

  let cursor = $state<string>();

  let previous = $state<z.infer<typeof runtimeLog>[]>([]);

  let feedback = $state("");

  let refreshing = $state(false);

  const input = $derived(
    connectorLogQuery.parse({
      name: data.name,
      since: selected.since,
      query: selected.query || undefined,
      level: selected.level || undefined,
      version: selected.version || undefined,
      cursor,
    }),
  );

  const logs = $derived(getConnectorLogs(input));

  const result = $derived(await logs);

  const entries = $derived([...previous, ...(result.page?.entries ?? [])]);

  const apply = (event: SubmitEvent) => {
    event.preventDefault();

    const parsed = connectorLogQuery.safeParse({
      name: data.name,
      since,
      query: search || undefined,
      level: level || undefined,
      version: version || undefined,
    });

    if (!parsed.success) {
      feedback = parsed.error.issues[0]?.message ?? "Check the filters";

      return;
    }

    feedback = "";
    previous = [];
    cursor = undefined;
    selected = { since, query: search, level, version };
  };

  const refresh = async () => {
    previous = [];
    cursor = undefined;
    refreshing = true;

    try {
      await getConnectorLogs({ ...input, cursor: undefined }).refresh();
    } finally {
      refreshing = false;
    }
  };
</script>

<svelte:head><title>{data.name} logs · Widefleet</title></svelte:head>
<Button href="/connectors" variant="ghost" size="sm" class="mb-5 -ml-3"
  ><ArrowLeft />Connectors</Button
>
<div class="flex items-start justify-between gap-5">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">{data.name} logs</h1>
    <p class="text-muted-foreground mt-2 text-sm">
      Runtime output across this connector’s versions. Administrator access only.
    </p>
  </div>
  <Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}
    ><RefreshCw
      class={refreshing ? "animate-spin motion-reduce:animate-none" : ""}
    />Refresh</Button
  >
</div>
<form onsubmit={apply} class="mt-7 flex flex-wrap items-end gap-3">
  <div class="space-y-2">
    <Label for="since">Since</Label><Input
      id="since"
      bind:value={since}
      placeholder="1h"
      class="w-28"
    />
  </div>
  <div class="min-w-48 flex-1 space-y-2">
    <Label for="search">Search</Label><Input
      id="search"
      bind:value={search}
      placeholder="Message text"
    />
  </div>
  <div class="space-y-2">
    <Label for="level">Minimum level</Label><NativeSelect.Root id="level" bind:value={level}
      ><NativeSelect.Option value="">All levels</NativeSelect.Option><NativeSelect.Option
        value="debug">Debug</NativeSelect.Option
      ><NativeSelect.Option value="info">Info</NativeSelect.Option><NativeSelect.Option value="warn"
        >Warning</NativeSelect.Option
      ><NativeSelect.Option value="error">Error</NativeSelect.Option></NativeSelect.Root
    >
  </div>
  <Button type="submit" variant="secondary">Apply filters</Button>
  <details class="basis-full text-sm">
    <summary class="text-muted-foreground cursor-pointer py-1">Filter by version</summary>
    <div class="mt-2 max-w-md space-y-2">
      <Label for="version">Version ID</Label><Input
        id="version"
        bind:value={version}
        placeholder="All versions"
      />
    </div>
  </details>
</form>
{#if feedback}<div class="mt-4"><Feedback kind="error">{feedback}</Feedback></div>{/if}
{#if result.message}<div class="mt-6"><Feedback kind="error">{result.message}</Feedback></div>
{:else if entries.length === 0}<div
    class="text-muted-foreground mt-8 rounded-xl border border-dashed p-10 text-center text-sm"
  >
    No logs match these filters. Invoke the connector, then refresh.
  </div>
{:else}
  <div class="mt-6 divide-y rounded-xl border">
    {#each entries as entry (entry.id)}
      <details class="group px-4 py-3 text-sm">
        <summary class="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-2">
          <time class="text-muted-foreground shrink-0 font-mono text-xs" datetime={entry.timestamp}
            >{entry.timestamp}</time
          >
          <Badge variant={entry.level === "error" ? "destructive" : "secondary"} class="font-normal"
            >{entry.level}</Badge
          >
          <span class="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">{entry.message}</span>
        </summary>
        <div class="text-muted-foreground mt-3 space-y-2 border-t pt-3 text-xs">
          <p>
            Version <code>{entry.connectorVersion ?? "Unknown"}</code> · {entry.source} · {entry.kind}
          </p>
          {#if entry.requestId}<p>Request <code>{entry.requestId}</code></p>{/if}
          {#if entry.stack}<pre
              class="overflow-auto whitespace-pre-wrap wrap-anywhere">{entry.stack}</pre>{/if}
        </div>
      </details>
    {/each}
  </div>
  {#if result.page?.nextCursor}
    <Button
      variant="outline"
      class="mt-4"
      onclick={() => {
        previous = entries;
        cursor = result.page?.nextCursor ?? undefined;
      }}>Load more</Button
    >
  {/if}
{/if}
