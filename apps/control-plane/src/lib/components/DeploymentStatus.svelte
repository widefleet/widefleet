<script lang="ts">
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import CircleDashed from "@lucide/svelte/icons/circle-dashed";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import type { deployment } from "@platform/contracts";
  import type { z } from "zod";

  let { status }: { status: z.infer<typeof deployment>["status"] } = $props();
</script>

<span class="inline-flex items-center gap-2 text-sm font-medium">
  {#if status === "succeeded"}<CircleCheck
      class="size-4 text-emerald-600 dark:text-emerald-400"
    />Published
  {:else if status === "failed"}<CircleX class="text-destructive size-4" />Failed
  {:else if status === "running"}<LoaderCircle
      class="text-primary size-4 animate-spin motion-reduce:animate-none"
    />Deploying
  {:else}<CircleDashed class="size-4 text-amber-600 dark:text-amber-400" />Waiting for agent{/if}
</span>
