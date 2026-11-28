<script lang="ts">
  import mark from "./assets/widefleet-mark-q2.svg?inline";

  let { compact = false }: { compact?: boolean } = $props();
</script>

<span class="text-foreground inline-flex items-center gap-2 px-2 py-1.5">
  <img
    src={mark}
    width="1052"
    height="563"
    alt=""
    aria-hidden="true"
    class="h-5 w-auto shrink-0 object-contain dark:invert"
  />
  {#if !compact}<span class="text-xl leading-none font-semibold tracking-[-1px]">widefleet</span
    >{/if}
</span>
