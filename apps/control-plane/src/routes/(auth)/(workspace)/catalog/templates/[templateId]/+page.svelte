<script lang="ts">
  import { getTemplate } from "#lib/catalog.remote";
  import { page } from "$app/state";
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
  <div class="markdown mt-8 border-t pt-6 text-sm leading-7 wrap-anywhere">
    {@html template.html}
  </div>
</div>

<style>
  .markdown :global(h1),
  .markdown :global(h2) {
    font-size: 1.125rem;
    font-weight: 600;
    margin-block: 1.5rem 0.75rem;
  }
  .markdown :global(h3),
  .markdown :global(h4) {
    font-weight: 600;
    margin-block: 1rem 0.5rem;
  }
  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol),
  .markdown :global(pre),
  .markdown :global(blockquote),
  .markdown :global(table) {
    margin-block: 0.75rem;
  }
  .markdown :global(ul) {
    list-style: disc;
    padding-left: 1.5rem;
  }
  .markdown :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
  }
  .markdown :global(li) {
    margin-block: 0.25rem;
  }
  .markdown :global(a) {
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .markdown :global(a:focus-visible) {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .markdown :global(pre) {
    overflow-x: auto;
    padding: 1rem;
    border-radius: var(--radius);
    background: var(--muted);
  }
  .markdown :global(code) {
    font-size: 0.8125rem;
  }
  .markdown :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 1rem;
    color: var(--muted-foreground);
  }
  .markdown :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--border);
    padding: 0.25rem 0.75rem;
    text-align: left;
  }
  .markdown :global(img) {
    max-width: 100%;
    height: auto;
  }
  .markdown :global(hr) {
    border-color: var(--border);
    margin-block: 1.5rem;
  }
</style>
