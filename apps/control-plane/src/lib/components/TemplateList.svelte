<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import { getTemplates } from "#lib/catalog.remote";
  import { page } from "$app/state";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import { Textarea } from "@platform/ui/textarea";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import EmptyState from "./EmptyState.svelte";
  import TemplateIcon from "./TemplateIcon.svelte";
  import Search from "@lucide/svelte/icons/search";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const search = $derived((page.url.searchParams.get("q") ?? "").trim().slice(0, 200));

  // GitHub hosts the templates. The page around them stays usable when it cannot be reached.
  const catalog = $derived(
    await getTemplates({ organizationId: workspace.organizationId, search }).catch(
      (cause: unknown) => {
        if (isHttpError(cause) && cause.status >= 500) return null;
        throw cause;
      },
    ),
  );

  let copied = $state(false);

  // Where the browser refuses to copy, the prompt appears so it can be selected by hand.
  let failed = $state(false);

  const copy = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
      failed = false;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      failed = true;
    }
  };
</script>

{#if catalog}
  <section aria-labelledby="build-with-agent" class="mb-10 rounded-lg border p-4">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div>
        <h2 id="build-with-agent" class="text-sm font-semibold">Build it with your agent</h2>
        <p class="text-muted-foreground mt-1 text-sm">
          Copy the prompt and tell your agent what you need. It builds and deploys the app for you.
        </p>
      </div>
      <Button onclick={() => copy(catalog.createPrompt)}
        >{#if copied}<Check />Copied{:else}<Copy />Copy prompt{/if}</Button
      ><span class="sr-only" aria-live="polite">{copied ? "Copied to clipboard." : ""}</span>
    </div>
    {#if failed}
      <!-- A text area takes keyboard focus, so the prompt can be selected without a pointer. -->
      <div class="mt-4 space-y-2">
        <Label for="create-prompt">Prompt for your agent</Label>
        <Textarea
          id="create-prompt"
          readonly
          rows={4}
          value={catalog.createPrompt}
          aria-describedby="create-prompt-help"
          class="font-mono text-xs"
          onfocus={(event) => event.currentTarget.select()}
        />
        <p id="create-prompt-help" class="text-muted-foreground text-xs" role="alert">
          Copying is not available here. Select the prompt and copy it manually.
        </p>
      </div>
    {/if}
    <!-- Without JavaScript the button cannot copy, so the prompt stands here as text. -->
    <noscript
      ><code class="mt-4 block text-xs leading-6 whitespace-pre-wrap wrap-anywhere"
        >{catalog.createPrompt}</code
      ></noscript
    >
  </section>
{/if}
<div class="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
  <div>
    <h2 class="text-lg font-semibold">Start from a template</h2>
    <p class="text-muted-foreground mt-1 text-sm">
      Choose an app, then let your agent deploy and set it up.
    </p>
  </div>
  <form method="GET" role="search" class="flex w-full gap-2 sm:w-auto">
    <Input
      type="search"
      name="q"
      value={search}
      maxlength={200}
      placeholder="Search templates …"
      aria-label="Search templates"
      class="sm:w-56"
    />
    <Button type="submit" variant="outline"
      ><Search /><span class="sr-only sm:not-sr-only">Search</span></Button
    >
  </form>
</div>
{#if !catalog}
  <p role="status" class="text-muted-foreground py-10 text-center text-sm">
    Templates are unavailable right now. Try again later.
  </p>
{:else if catalog.templates.length === 0}
  <EmptyState
    title="No matching templates"
    description="Try another search or create an app with your agent."
  >
    {#snippet icon()}<Search />{/snippet}
    <Button href={page.url.pathname} variant="outline">Reset search</Button>
  </EmptyState>
{:else}
  <ul class="divide-y">
    {#each catalog.templates as template (template.id)}
      <li>
        <a
          href={workspace.path(`/catalog/templates/${template.id}`)}
          class="hover:bg-muted/40 group flex items-center justify-between gap-5 rounded-md px-2 py-5"
        >
          <div class="flex min-w-0 items-start gap-3">
            <TemplateIcon templateId={template.id} />
            <div class="min-w-0">
              <h3 class="text-sm font-semibold">{template.name}</h3>
              <p class="text-muted-foreground mt-1 text-sm leading-6">{template.description}</p>
            </div>
          </div>
          <span class="text-muted-foreground flex shrink-0 items-center gap-3 text-sm">
            {#if template.installedAppId}Installed{/if}
            <ArrowRight class="size-4" />
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}
