<script lang="ts">
  import { Button } from "@platform/ui/button";
  import { Label } from "@platform/ui/label";
  import { Textarea } from "@platform/ui/textarea";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";

  let {
    id,
    title,
    description,
    prompt,
    class: classes = "",
  }: { id: string; title: string; description: string; prompt: string; class?: string } = $props();

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

<section aria-labelledby={`${id}-heading`} class={`rounded-lg border p-4 ${classes}`}>
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
    <div>
      <h2 id={`${id}-heading`} class="text-sm font-semibold">{title}</h2>
      <p class="text-muted-foreground mt-1 text-sm">{description}</p>
    </div>
    <Button onclick={copy}
      >{#if copied}<Check />Copied{:else}<Copy />Copy prompt{/if}</Button
    ><span class="sr-only" aria-live="polite">{copied ? "Copied to clipboard." : ""}</span>
  </div>
  {#if failed}
    <!-- A text area takes keyboard focus, so the prompt can be selected without a pointer. -->
    <div class="mt-4 space-y-2">
      <Label for={`${id}-prompt`}>Prompt for your agent</Label>
      <Textarea
        id={`${id}-prompt`}
        readonly
        rows={4}
        value={prompt}
        aria-describedby={`${id}-prompt-help`}
        class="font-mono text-xs"
        onfocus={(event) => event.currentTarget.select()}
      />
      <p id={`${id}-prompt-help`} class="text-muted-foreground text-xs" role="alert">
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
