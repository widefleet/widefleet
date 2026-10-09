<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    children,
  }: { title: string; description?: string; children?: Snippet } = $props();
</script>

<div class="flex flex-wrap items-start justify-between gap-4">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">{title}</h1>
    {#if description}<p class="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
        {description}
      </p>{/if}
  </div>
  {#if children}<div class="flex shrink-0 items-center gap-2">{@render children()}</div>{/if}
</div>
