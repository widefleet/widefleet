<script lang="ts">
  import type { capabilityState } from "@platform/contracts";
  import type { z } from "zod";
  import { Badge } from "@platform/ui/badge";

  let {
    state,
    removing = false,
  }: { state: z.infer<typeof capabilityState>["state"]; removing?: boolean } = $props();

  const labels = {
    active: "Active",
    saved: "Saved",
    pending: "Pending",
    failed: "Failed",
  } satisfies Record<z.infer<typeof capabilityState>["state"], string>;
</script>

<Badge variant="outline" class="shrink-0 gap-1.5 font-normal">
  <span
    aria-hidden="true"
    class={`size-1.5 rounded-full ${state === "active" ? "bg-emerald-500" : state === "failed" ? "bg-destructive" : state === "pending" ? "bg-amber-500" : "bg-muted-foreground/50"}`}
  ></span>
  {removing ? (state === "failed" ? "Removal failed" : "Removal pending") : labels[state]}
</Badge>
