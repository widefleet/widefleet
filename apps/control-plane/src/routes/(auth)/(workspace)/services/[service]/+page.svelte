<script lang="ts">
  import Markdown from "#shadcn/components/Markdown.svelte";
  import { getServiceDescription } from "#lib/services.remote";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const service = $derived(await getServiceDescription({ service: data.service }));
</script>

<svelte:head><title>{service.displayName} API · Widefleet</title></svelte:head>
<div class="max-w-3xl space-y-6">
  <a class="text-sm underline underline-offset-4" href="/services">Back to app APIs</a>
  <div>
    <h1 class="text-xl font-semibold">{service.displayName} API</h1>
    <p class="text-muted-foreground mt-2 text-sm">
      Methods available in the app’s active deployment. Use the binding name configured in your
      app’s connections.
    </p>
  </div>
  {#if service.html}
    <article><Markdown html={service.html} /></article>
  {:else if service.documentation}
    <p class="text-muted-foreground text-sm">
      No API documentation was generated. Check the provider app’s deployment diagnostics.
    </p>
  {:else}
    <p class="text-muted-foreground text-sm">
      This deployment has no API documentation. Redeploy the provider app with a CLI that supports
      API documentation.
    </p>
  {/if}
</div>
