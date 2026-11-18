<script lang="ts">
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";
  import { onDestroy } from "svelte";
  import { Button } from "@platform/ui/button";

  let {
    value,
    label = "Copy",
    failed = $bindable(false),
  }: { value: string; label?: string; failed?: boolean } = $props();

  let copied = $state(false);

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

<Button
  variant="ghost"
  size="icon-sm"
  aria-label={copied ? "Copied" : label}
  title={label}
  onclick={copy}
  class="shrink-0"
  >{#if copied}<Check class="text-emerald-600" />{:else}<Copy />{/if}</Button
><span class="sr-only" aria-live="polite">{copied ? "Copied to clipboard." : ""}</span>
