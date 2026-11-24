<script lang="ts">
  import { getCreatePrompt } from "#lib/catalog.remote";
  import { page } from "$app/state";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import { Textarea } from "@platform/ui/textarea";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import TemplateEntries from "./TemplateEntries.svelte";
  import Search from "@lucide/svelte/icons/search";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const search = $derived((page.url.searchParams.get("q") ?? "").trim().slice(0, 200));

  const prompt = $derived(await getCreatePrompt({ organizationId: workspace.organizationId }));

  let copied = $state(false);

  // Where the browser refuses to copy, the prompt appears so it can be selected by hand.
  let failed = $state(false);

  const copy = async () => {
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

<section aria-labelledby="build-with-agent" class="mb-10 rounded-lg border p-4">
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
    <div>
      <h2 id="build-with-agent" class="text-sm font-semibold">Build it with your agent</h2>
      <p class="text-muted-foreground mt-1 text-sm">
        Copy the prompt and tell your agent what you need. It builds and deploys the app for you.
      </p>
    </div>
    <Button onclick={copy}
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
        value={prompt}
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
    ><code class="mt-4 block text-xs leading-6 whitespace-pre-wrap wrap-anywhere">{prompt}</code
    ></noscript
  >
</section>
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
<!-- GitHub can be slow. The prompt above and the search stay usable while the templates load. -->
<svelte:boundary>
  <TemplateEntries {search} />
  {#snippet pending()}
    <p role="status" class="text-muted-foreground py-10 text-center text-sm">Loading templates …</p>
  {/snippet}
</svelte:boundary>
