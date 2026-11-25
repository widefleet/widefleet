<script lang="ts">
  import { getTemplate, installTemplate } from "#lib/catalog.remote";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import { page } from "$app/state";
  import Markdown from "#shadcn/components/Markdown.svelte";
  import AgentPromptCard from "#shadcn/components/AgentPromptCard.svelte";
  import TemplateIcon from "#shadcn/components/TemplateIcon.svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const template = $derived(
    await getTemplate({
      organizationId: workspace.organizationId,
      templateId: page.params.templateId ?? "",
    }),
  );

  // An app with the template's name exists: ask for another name.
  const naming = $derived(
    Boolean(installTemplate.fields.name.issues()?.length || installTemplate.fields.name.value()),
  );

  // The install saves these secrets first, so it waits for every value.
  const secretsEntered = $derived(
    template.requiredSecrets.every((secret) =>
      Boolean(installTemplate.fields._secrets[secret]?.value()),
    ),
  );
</script>

{#snippet installFields()}
  <OrganizationField field={installTemplate.fields.organizationId} />
  <input {...installTemplate.fields.templateId.as("hidden", template.id)} />
  <input
    {...installTemplate.fields.network.as(
      "hidden",
      JSON.stringify(template.network ?? { backend: [], browser: [] }),
    )}
  />
{/snippet}

{#snippet nameField(classes: string, id?: string)}
  <Input
    {...installTemplate.fields.name.as("text")}
    {id}
    aria-label="App name"
    placeholder={`${template.id}-2`}
    required
    maxlength={48}
    pattern="[a-z]([a-z0-9-]*[a-z0-9])?"
    class={classes}
    disabled={installTemplate.pending > 0}
  />
{/snippet}

<svelte:head><title>{template.name} template · Widefleet</title></svelte:head>
<a
  href={workspace.path("/catalog/templates")}
  class="text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-2 text-sm"
  ><ArrowLeft class="size-4" />All templates</a
>
<div class="max-w-3xl">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        <TemplateIcon templateId={template.id} />{template.name}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm leading-6">{template.description}</p>
    </div>
    {#if template.installedAppId}
      <Button href={workspace.path(`/apps/${template.installedAppId}`)} class="w-full sm:w-auto"
        >Open</Button
      >
    {:else if template.installable && template.requiredSecrets.length === 0}
      <form {...installTemplate} class="flex w-full gap-2 sm:w-auto">
        {@render installFields()}
        {#if naming}
          {@render nameField("min-w-0 flex-1 sm:w-48")}
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
  {#if !template.installedAppId && template.installable && template.requiredSecrets.length > 0}
    <form
      {...installTemplate}
      class="mt-6 space-y-4 rounded-lg border p-4"
      aria-labelledby="secrets-heading"
    >
      {@render installFields()}
      <div>
        <h2 id="secrets-heading" class="text-sm font-semibold">Required secrets</h2>
        <p class="text-muted-foreground mt-1 text-sm leading-6">
          The app needs these values to run. They are saved as app secrets; the instructions below
          explain where to get them.
        </p>
      </div>
      {#each template.secretFields as { name: secret, helpHtml } (secret)}
        <div class="space-y-2">
          <Label for={`secret-${secret}`}><code>{secret}</code></Label>
          <Input
            {...installTemplate.fields._secrets[secret]?.as("password")}
            id={`secret-${secret}`}
            aria-describedby={helpHtml ? `secret-help-${secret}` : undefined}
            autocomplete="new-password"
            spellcheck={false}
            required
            disabled={installTemplate.pending > 0}
          />
          {#if helpHtml}
            <div id={`secret-help-${secret}`} class="text-muted-foreground">
              <Markdown html={helpHtml} />
            </div>
          {/if}
        </div>
      {/each}
      {#if naming}
        <div class="space-y-2">
          <Label for="app-name">App name</Label>
          {@render nameField("sm:w-64", "app-name")}
        </div>
      {/if}
      <Button
        type="submit"
        class="w-full sm:w-auto"
        disabled={installTemplate.pending > 0 || !secretsEntered}
        >{installTemplate.pending ? "Installing …" : "Install"}</Button
      >
    </form>
  {/if}
  <FormIssues issues={installTemplate.fields.allIssues()} />
  {#if !template.installedAppId && template.installable && template.network && template.network.backend.length + template.network.browser.length > 0}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Installing allows the app to connect to
      {#each [...new Set( [...template.network.backend, ...template.network.browser] )] as origin, index (origin)}
        {index > 0 ? ", " : ""}<code class="text-foreground">{new URL(origin).host}</code>
      {/each}.
    </p>
  {/if}
  <AgentPromptCard
    id="setup"
    title="Set up with your agent"
    description="Copy the prompt into your agent. It deploys the app to this organization and guides you through configuration."
    prompt={template.prompt}
    class="mt-8"
  />
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
