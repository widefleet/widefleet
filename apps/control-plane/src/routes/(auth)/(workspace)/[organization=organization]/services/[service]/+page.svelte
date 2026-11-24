<script lang="ts">
  import ServiceReference from "#shadcn/components/ServiceReference.svelte";
  import { getServiceDescription } from "#lib/services.remote";
  import { Button } from "@platform/ui/button";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import type { PageProps } from "./$types";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let { params }: PageProps = $props();

  const service = $derived(
    await getServiceDescription({
      organizationId: workspace.organizationId,
      service: params.service,
    }),
  );
</script>

<svelte:head><title>{service.displayName} API · Widefleet</title></svelte:head>
<a
  href={workspace.path("/services")}
  class="text-muted-foreground hover:text-foreground mb-6 inline-flex items-center gap-2 text-xs"
  ><ArrowLeft class="size-3.5" />Back to app APIs</a
>
<div class="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
  <div class="min-w-0">
    <p class="text-muted-foreground mb-2 text-[11px] font-medium tracking-wider uppercase">
      App API
    </p>
    <h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">{service.displayName}</h1>
    <p class="text-muted-foreground mt-2 font-mono text-xs wrap-anywhere">{service.slug}</p>
  </div>
  <Button href={workspace.path(`/services/${service.appId}/connect`)}>Set up connection</Button>
</div>
<div class="mt-8"><ServiceReference {service} /></div>
