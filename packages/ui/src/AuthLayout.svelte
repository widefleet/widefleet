<script lang="ts">
  import type { Snippet } from "svelte";
  import Brand from "./Brand.svelte";
  import { cn } from "./utils.ts";

  let {
    children,
    action,
    wide = false,
    homeHref = "/",
    class: className,
  }: {
    children: Snippet;
    action?: Snippet;
    wide?: boolean;
    homeHref?: string | null;
    class?: string;
  } = $props();
</script>

<div class="bg-sidebar flex min-h-svh flex-col">
  <header class="flex items-center justify-between gap-4 px-6 py-6 sm:px-10">
    {#if homeHref}<a href={homeHref} aria-label="Widefleet home"><Brand /></a>{:else}<Brand />{/if}
    {@render action?.()}
  </header>
  <main
    id="main-content"
    class={`mx-auto flex w-full flex-1 items-center px-5 py-10 sm:py-16 ${wide ? "max-w-2xl" : "max-w-md"}`}
  >
    <div class={cn("bg-background w-full rounded-2xl border p-7 shadow-xs sm:p-9", className)}>
      {@render children()}
    </div>
  </main>
  <footer class="text-muted-foreground px-6 py-6 text-center text-xs">Widefleet</footer>
</div>
