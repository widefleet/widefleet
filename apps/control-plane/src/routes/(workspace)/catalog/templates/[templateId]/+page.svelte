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
  <ul class="text-muted-foreground mt-4 list-disc space-y-1 pl-5 text-sm">
    {#each template.capabilities as capability (capability)}<li>{capability}</li>{/each}
  </ul>
  <section class="mt-8" aria-labelledby="setup-heading">
    <h3 id="setup-heading" class="text-sm font-semibold">Set up with your agent</h3>
    <p class="text-muted-foreground mt-2 mb-4 text-sm leading-6">
      Copy this prompt into your agent. It will deploy the app to this organization and guide you
      through configuration. You’ll need an administrator to provide OAuth credentials and allow the
      app’s connections.
    </p>
    <CopyValue value={template.prompt} label="Copy setup prompt" />
  </section>
  <section class="mt-8" aria-labelledby="requirements-heading">
    <h3 id="requirements-heading" class="text-sm font-semibold">Account setup</h3>
    <p class="text-muted-foreground mt-2 text-sm leading-6">{template.setup}</p>
  </section>
  <a
    href={template.source}
    target="_blank"
    rel="noreferrer"
    class="mt-5 inline-flex items-center gap-1 text-sm underline underline-offset-4"
    >View source<ArrowUpRight class="size-3.5" /><span class="sr-only">Opens in a new tab</span></a
  >
  <details class="mt-8 border-t pt-5">
    <summary class="cursor-pointer text-sm font-medium">Setup instructions and examples</summary>
    <ol class="text-muted-foreground mt-4 list-decimal space-y-4 pl-5 text-sm leading-6">
      {#each template.instructions.split("\n\n") as instruction (instruction)}<li
          class="wrap-anywhere"
        >
          {instruction}
        </li>{/each}
    </ol>
    <p class="mt-6 text-sm font-medium">App secrets</p>
    <p class="text-muted-foreground mt-2 font-mono text-xs leading-6 wrap-anywhere">
      {template.secrets.join(", ")}
    </p>
    {#each template.examples as example (example.description)}
      <p class="mt-6 mb-3 text-sm leading-6">{example.description}</p>
      <CopyValue value={example.code} label="Copy example" />
    {/each}
  </details>
</div>
