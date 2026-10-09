<script lang="ts">
  let { compact = false }: { compact?: boolean } = $props();
</script>

<span class="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-black dark:bg-[#fafaf7]">
  <img
    src="/brand/widefleet-mark-q2.svg"
    width="1052"
    height="563"
    alt=""
    aria-hidden="true"
    class="h-5 w-auto shrink-0 object-contain"
  />
  {#if !compact}<span class="text-xl leading-none font-semibold tracking-[-1px]">widefleet</span
    >{/if}
</span>
