<script lang="ts">
  import { getTemplate, installTemplate } from "#lib/catalog.remote";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
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
  {#if template.installable}
    {@const installing = installTemplate.pending > 0}
    <section class="mt-8" aria-labelledby="install-heading">
      <h3 id="install-heading" class="text-sm font-semibold">Install</h3>
      <p class="text-muted-foreground mt-2 mb-4 text-sm leading-6">
        Widefleet builds the template and deploys it as an app in this organization. Then complete
        the setup steps below.
      </p>
      <form {...installTemplate} class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <OrganizationField field={installTemplate.fields.organizationId} />
        <input {...installTemplate.fields.templateId.as("hidden", template.id)} />
        <div class="grid flex-1 gap-2">
          <Label for="template-app-name">App name</Label>
          <Input
            id="template-app-name"
            {...installTemplate.fields.name.as("text")}
            placeholder={template.id}
            autocomplete="off"
            spellcheck="false"
            disabled={installing}
          />
        </div>
        <Button type="submit" disabled={installing}
          >{installing ? "Installing …" : "Install"}</Button
        >
      </form>
      <p class="text-muted-foreground mt-2 text-xs leading-5" aria-live="polite">
        {installing
          ? "Building and uploading the app. This can take a minute."
          : `Part of your app's address. Leave it empty to use ${template.id}; installing again updates that app.`}
      </p>
      <FormIssues issues={installTemplate.fields.allIssues()} />
    </section>
  {/if}
  <section class="mt-8" aria-labelledby="setup-heading">
    <h3 id="setup-heading" class="text-sm font-semibold">Set up with your agent</h3>
    <p class="text-muted-foreground mt-2 mb-4 text-sm leading-6">
      {template.installable
        ? "To adapt the template first, copy this prompt into your agent. It deploys the app to this organization and guides you through configuration."
        : "Copy this prompt into your agent. It will deploy the app to this organization and guide you through configuration."}
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
