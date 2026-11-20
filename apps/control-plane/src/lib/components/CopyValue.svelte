<script lang="ts">
  import CopyButton from "./CopyButton.svelte";

  let {
    value,
    label = "Copy",
    secret = false,
  }: { value: string; label?: string; secret?: boolean } = $props();

  let failed = $state(false);
</script>

<div class="bg-muted/50 flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2.5">
  <code
    class="min-w-0 flex-1 self-center text-xs leading-6 whitespace-pre-wrap wrap-anywhere select-all"
    class:ph-no-capture={secret}
    data-private={secret || undefined}>{value}</code
  >
  <CopyButton {value} {label} bind:failed />
</div>
{#if failed}<p class="text-muted-foreground mt-1 text-xs" role="alert">
    Copying is not available here. Select the text and copy it manually.
  </p>{/if}
