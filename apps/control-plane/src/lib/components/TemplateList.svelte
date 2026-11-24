<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import { getTemplates } from "#lib/catalog.remote";
  import { page } from "$app/state";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import EmptyState from "./EmptyState.svelte";
  import CopyValue from "./CopyValue.svelte";
  import TemplateIcon from "./TemplateIcon.svelte";
  import Search from "@lucide/svelte/icons/search";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
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

<div class={catalog ? "grid gap-10 xl:grid-cols-2" : ""}>
  {#if catalog}
    <section
      aria-labelledby="create-with-agent"
      class="flex flex-col items-start xl:sticky xl:top-10 xl:items-center xl:self-start xl:py-16 xl:text-center"
    >
      <h2 id="create-with-agent" class="text-lg font-semibold">Build it with your agent</h2>
      <p class="text-muted-foreground mt-1 mb-4 max-w-sm text-sm">
        Copy the prompt and tell your agent what you need. It builds and deploys the app for you.
      </p>
      <Button onclick={() => copy(catalog.createPrompt)}
        >{#if copied}<Check />Copied{:else}<Copy />Copy prompt{/if}</Button
      ><span class="sr-only" aria-live="polite">{copied ? "Copied to clipboard." : ""}</span>
      {#if failed}
        <div class="mt-4 w-full text-left">
          <p class="text-muted-foreground mb-2 text-xs" role="alert">
            Copying is not available here. Select the text and copy it manually.
          </p>
          <CopyValue value={catalog.createPrompt} label="Copy create app prompt" />
        </div>
      {/if}
    </section>
  {/if}
  <div class="min-w-0">
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
  </div>
</div>
