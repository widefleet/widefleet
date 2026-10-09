<script lang="ts">
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import type { app } from "@platform/contracts";
  import type { z } from "zod";

  let { state }: { state: z.infer<typeof app>["state"] } = $props();
</script>

<Badge
  variant="outline"
  class="gap-1.5 whitespace-nowrap border-transparent bg-muted/60 px-2 py-1 font-normal"
>
  <span
    class={`size-1.5 rounded-full ${state === "active" ? "bg-emerald-500" : state === "deleting" ? "bg-amber-500" : "bg-muted-foreground/50"}`}
    aria-hidden="true"
  ></span>
  {state === "active" ? "Active" : state === "deleting" ? "Deleting" : "Not published yet"}
</Badge>
