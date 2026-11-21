<script lang="ts">
  import { getTemplate, installTemplate } from "#lib/catalog.remote";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import { page } from "$app/state";
  import Markdown from "#shadcn/components/Markdown.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import TemplateIcon from "#shadcn/components/TemplateIcon.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";

  const template = $derived(await getTemplate({ templateId: page.params.templateId ?? "" }));

  // An app with the template's name exists: ask for another name.
  const naming = $derived(
    Boolean(installTemplate.fields.name.issues()?.length || installTemplate.fields.name.value()),
  );
</script>

<svelte:head><title>{template.name} template · Widefleet</title></svelte:head>
<a
  href="/catalog/templates"
  class="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-2 text-sm"
  ><ArrowLeft class="size-4" />All templates</a
>
<div class="max-w-3xl">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h2 class="flex items-center gap-3 text-2xl font-semibold">
        <TemplateIcon templateId={template.id} />{template.name}
      </h2>
      <p class="text-muted-foreground mt-2 text-sm leading-6">{template.description}</p>
    </div>
    {#if template.installedAppId}
      <Button href={`/apps/${template.installedAppId}`} class="w-full sm:w-auto">Open</Button>
    {:else if template.installable}
      <form {...installTemplate} class="flex w-full gap-2 sm:w-auto">
        <OrganizationField field={installTemplate.fields.organizationId} />
        <input {...installTemplate.fields.templateId.as("hidden", template.id)} />
        <input
          {...installTemplate.fields.network.as(
            "hidden",
            JSON.stringify(template.network ?? { backend: [], browser: [] }),
          )}
        />
        {#if naming}
          <Input
            {...installTemplate.fields.name.as("text")}
            aria-label="App name"
            placeholder={`${template.id}-2`}
            required
            maxlength={48}
            pattern="[a-z]([a-z0-9-]*[a-z0-9])?"
            class="min-w-0 flex-1 sm:w-48"
            disabled={installTemplate.pending > 0}
          />
        {/if}
        <Button
          type="submit"
          class={naming ? "" : "w-full sm:w-auto"}
          disabled={installTemplate.pending > 0}
          >{installTemplate.pending ? "Installing …" : "Install"}</Button
        >
      </form>
    {/if}
  </div>
  <FormIssues issues={installTemplate.fields.allIssues()} />
  {#if !template.installedAppId && template.installable && template.network && template.network.backend.length + template.network.browser.length > 0}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Installing allows the app to connect to
      {#each [...new Set( [...template.network.backend, ...template.network.browser] )] as origin, index (origin)}
        {index > 0 ? ", " : ""}<code class="text-foreground">{new URL(origin).host}</code>
      {/each}.
    </p>
  {/if}
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
