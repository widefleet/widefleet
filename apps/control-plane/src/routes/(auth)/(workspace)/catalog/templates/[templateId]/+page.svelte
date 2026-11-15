<script lang="ts">
  import { getTemplate } from "#lib/catalog.remote";
  import { page } from "$app/state";
  import Markdown from "#shadcn/components/Markdown.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";

  const template = $derived(await getTemplate({ templateId: page.params.templateId ?? "" }));
</script>

<svelte:head><title>{template.name} template · Widefleet</title></svelte:head>
<a
  href="/catalog/templates"
  class="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-2 text-sm"
  ><ArrowLeft class="size-4" />All templates</a
>
<div class="max-w-3xl">
  <h2 class="text-2xl font-semibold">{template.name}</h2>
  <p class="text-muted-foreground mt-2 text-sm leading-6">{template.description}</p>
  <section class="mt-8" aria-labelledby="setup-heading">
    <h3 id="setup-heading" class="text-sm font-semibold">Set up with your agent</h3>
    <p class="text-muted-foreground mt-2 mb-4 text-sm leading-6">
      Copy this prompt into your agent. It will deploy the app to this organization and guide you
      through configuration.
    </p>
    <CopyValue value={template.prompt} label="Copy setup prompt" />
  </section>
  <a
    href={template.source}
    target="_blank"
    rel="noreferrer"
    class="mt-5 inline-flex items-center gap-1 text-sm underline underline-offset-4"
    >View source<ArrowUpRight class="size-3.5" /><span class="sr-only">Opens in a new tab</span></a
  >
  <div class="mt-8 border-t pt-6">
    <Markdown html={template.html} />
  </div>
</div>
