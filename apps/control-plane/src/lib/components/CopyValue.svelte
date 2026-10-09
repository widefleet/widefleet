<script lang="ts">
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import { onDestroy } from "svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";

  let {
    value,
    label = "Copy",
    secret = false,
  }: { value: string; label?: string; secret?: boolean } = $props();

  let copied = $state(false);

  let failed = $state(false);

  let timer: ReturnType<typeof setTimeout> | undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      failed = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      clearTimeout(timer);
      copied = false;
      failed = true;
    }
  };

  onDestroy(() => clearTimeout(timer));
</script>

<div class="bg-muted/50 flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2.5">
  <code
    class="min-w-0 flex-1 self-center text-xs leading-6 whitespace-pre-wrap wrap-anywhere select-all"
    data-private={secret || undefined}>{value}</code
  >
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label={copied ? "Copied" : label}
    title={label}
    onclick={copy}
    class="shrink-0"
    >{#if copied}<Check class="text-emerald-600" />{:else}<Copy />{/if}</Button
  >
</div>
{#if failed}<p class="text-muted-foreground mt-1 text-xs" role="alert">
    Copying is not available here. Select the text and copy it manually.
  </p>{/if}
<span class="sr-only" aria-live="polite">{copied ? "Copied to clipboard." : ""}</span>
