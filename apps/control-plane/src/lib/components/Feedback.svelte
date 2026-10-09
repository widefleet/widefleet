<script lang="ts">
  import type { Snippet } from "svelte";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Info from "@lucide/svelte/icons/info";
  import * as Alert from "#shadcn/components/ui/alert/index.js";

  let { kind = "info", children }: { kind?: "info" | "success" | "error"; children: Snippet } =
    $props();
</script>

<Alert.Root
  role={kind === "error" ? "alert" : "status"}
  variant={kind === "error" ? "destructive" : "default"}
  class={kind === "success"
    ? "border-emerald-600/20 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
    : "bg-muted/30"}
>
  {#if kind === "error"}<CircleAlert />{:else if kind === "success"}<CircleCheck />{:else}<Info
    />{/if}
  <Alert.Description class="text-current leading-relaxed">{@render children()}</Alert.Description>
</Alert.Root>
