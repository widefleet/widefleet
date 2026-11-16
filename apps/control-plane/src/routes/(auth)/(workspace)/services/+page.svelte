<script lang="ts">
  import { getAppServices } from "#lib/services.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const catalog = $derived(await getAppServices());

  let search = $state("");

  const entries = $derived(
    catalog.entries.filter(
      (entry) =>
        entry.appId !== data.app?.id &&
        `${entry.displayName} ${entry.slug}`.toLowerCase().includes(search.toLowerCase()),
    ),
  );

  const context = $derived(data.app ? `?app=${data.app.id}` : "");
</script>

<svelte:head><title>App APIs · Widefleet</title></svelte:head>
<div class="max-w-3xl space-y-8">
  <PageHeading
    title="App APIs"
    description={data.app
      ? `Choose an API for ${data.app.displayName}.`
      : "Choose an API to connect to your app."}
  >
    <Button href="/services/requests" variant="outline">Connection requests</Button>
  </PageHeading>
  {#if data.app}<a
      class="text-muted-foreground block text-sm underline underline-offset-4"
      href={`/apps/${data.app.id}/connections`}>Back to {data.app.displayName}</a
    >{/if}
  <Input aria-label="Search app APIs" placeholder="Search APIs" bind:value={search} />
  <div class="divide-y">
    {#each entries as entry (entry.appId)}
      <section
        aria-label={entry.displayName}
        class="flex flex-wrap items-center justify-between gap-4 py-6"
      >
        <div class="min-w-0 space-y-2">
          <h2 class="font-medium wrap-anywhere">{entry.displayName}</h2>
          <p class="text-muted-foreground text-sm">
            {entry.accessMode === "organization"
              ? "Available to your organization"
              : "Requires administrator approval"}
          </p>
          <a
            class="text-muted-foreground block text-sm underline underline-offset-4"
            href={`/services/${entry.appId}`}>View API documentation</a
          >
        </div>
        <Button variant="outline" href={`/services/${entry.appId}/connect${context}`}
          >Set up connection<span class="sr-only"> to {entry.displayName}</span></Button
        >
      </section>
    {:else}<p class="text-muted-foreground py-6 text-sm">
        No apps with published APIs match your search.
      </p>{/each}
  </div>
</div>
