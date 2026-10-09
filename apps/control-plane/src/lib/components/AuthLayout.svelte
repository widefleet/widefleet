<script lang="ts">
  import type { Snippet } from "svelte";
  import Brand from "./Brand.svelte";

  let { children, wide = false }: { children: Snippet; wide?: boolean } = $props();
</script>

<div class="bg-sidebar flex min-h-svh flex-col">
  <header class="flex items-center justify-between gap-4 px-6 py-6 sm:px-10">
    <a href="/" aria-label="Widefleet home"><Brand /></a><span
      class="text-muted-foreground hidden text-xs sm:inline">A home for your internal apps.</span
    >
  </header>
  <main
    id="main-content"
    class={`mx-auto flex w-full flex-1 items-center px-5 py-10 sm:py-16 ${wide ? "max-w-2xl" : "max-w-md"}`}
  >
    <div class="bg-background w-full rounded-2xl border p-7 shadow-xs sm:p-9">
      {@render children()}
    </div>
  </main>
  <footer class="text-muted-foreground px-6 py-6 text-center text-xs">
    Widefleet<span class="mx-2 text-border">/</span>Your ideas. Your infrastructure.
  </footer>
</div>
