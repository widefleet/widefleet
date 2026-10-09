<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    icon,
    children,
  }: { title: string; description: string; icon: Snippet; children?: Snippet } = $props();
</script>

<div class="flex flex-col items-center px-6 py-16 text-center sm:py-20">
  <div
    class="bg-background ring-border mb-5 grid size-12 place-items-center rounded-xl shadow-xs ring-1 [&_svg]:size-5 [&_svg]:text-muted-foreground"
  >
    {@render icon()}
  </div>
  <h2 class="text-base font-semibold tracking-tight">{title}</h2>
  <p class="text-muted-foreground mt-2 max-w-sm text-sm leading-6">{description}</p>
  {#if children}<div class="mt-6">{@render children()}</div>{/if}
</div>
