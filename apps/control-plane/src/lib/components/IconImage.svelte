<script lang="ts">
  import type { Snippet } from "svelte";

  // An app or template icon, with the fallback shown until it loads or when it fails.
  let { source, children }: { source: string | null; children: Snippet } = $props();

  let loaded = $state<string | null>(null);

  let failed = $state<string | null>(null);
</script>

<span
  class="text-muted-foreground relative grid size-6 shrink-0 place-items-center"
  aria-hidden="true"
>
  {#if source && source !== failed}
    {#key source}
      <img
        src={source}
        alt=""
        width="24"
        height="24"
        class="absolute size-6 object-contain"
        class:invisible={loaded !== source}
        onload={(event) => {
          loaded = event.currentTarget.getAttribute("src");
        }}
        onerror={(event) => {
          failed = event.currentTarget.getAttribute("src");
        }}
      />
    {/key}
  {/if}
  {#if !source || source !== loaded || source === failed}{@render children()}{/if}
</span>
