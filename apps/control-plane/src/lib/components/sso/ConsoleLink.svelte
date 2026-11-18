<script lang="ts">
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import type { Snippet } from "svelte";

  let { href, children }: { href: string; children: Snippet } = $props();
</script>

<a
  {href}
  target="_blank"
  rel="noreferrer"
  class="text-primary inline-flex items-center gap-0.5 font-medium hover:underline"
  >{@render children()}<ArrowUpRight class="size-3.5" aria-hidden="true" /><span class="sr-only"
    >(opens in a new tab)</span
  ></a
>
