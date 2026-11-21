<script lang="ts">
  import ServiceReference from "#shadcn/components/ServiceReference.svelte";
  import { getCatalog } from "#lib/catalog.remote";
  import { getAppServices, getServiceDescription } from "#lib/services.remote";
  import { Button } from "@platform/ui/button";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const catalog = $derived(await getAppServices());

  const service = $derived(await getServiceDescription({ service: data.service }));

  // Published apps can be opened from here.
  const published = $derived(
    (await getCatalog()).find((app) => app.id === service.appId)?.url ?? null,
  );
</script>

<svelte:head><title>{service.displayName} · Widefleet</title></svelte:head>
<a
  href="/"
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />Home</a
>
<div class="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
  <div class="min-w-0">
    <p class="text-muted-foreground mb-2 text-[11px] font-medium tracking-wider uppercase">App</p>
    <h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">{service.displayName}</h1>
    <p class="text-muted-foreground mt-2 font-mono text-xs wrap-anywhere">{service.slug}</p>
  </div>
  <div class="flex flex-wrap items-center gap-2">
    {#if service.entrypoints.length}<Button
        href={`/services/${service.appId}/connect`}
        variant={published ? "outline" : "default"}>Set up connection</Button
      >{/if}{#if published}<Button href={published} target="_blank" rel="noreferrer"
        >Open app<ArrowUpRight /></Button
      >{/if}
  </div>
</div>
<div class="mt-8"><ServiceReference {service} admin={catalog.admin} /></div>
