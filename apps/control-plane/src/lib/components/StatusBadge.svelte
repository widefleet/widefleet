<script lang="ts">
  import { Badge } from "@platform/ui/badge";

  let { tone, label }: { tone: "success" | "pending" | "neutral"; label: string } = $props();
</script>

<Badge
  variant="outline"
  class="gap-1.5 whitespace-nowrap border-transparent bg-muted/60 px-2 py-1 font-normal"
>
  <span
    class={`size-1.5 rounded-full ${tone === "success" ? "bg-emerald-500" : tone === "pending" ? "bg-amber-500" : "bg-muted-foreground/50"}`}
    aria-hidden="true"
  ></span>
  {label}
</Badge>
