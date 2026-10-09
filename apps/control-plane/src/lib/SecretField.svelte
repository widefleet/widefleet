<script lang="ts">
  import type { z } from "zod";
  import type { secretInput } from "@platform/contracts";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import LockKeyhole from "@lucide/svelte/icons/lock-keyhole";

  let {
    label,
    value = $bindable(),
    disabled = false,
  }: { label: string; value: z.infer<typeof secretInput>; disabled?: boolean } = $props();

  const id = $props.id();
</script>

<fieldset {disabled} class="space-y-2">
  <legend class="mb-2 text-sm font-medium">{label}</legend>
  {#if value.type === "stored"}
    <div class="bg-muted/30 flex items-center justify-between gap-3 rounded-lg border p-3">
      <p class="text-muted-foreground flex items-center gap-2 text-xs">
        <LockKeyhole class="size-3.5" />Credentials saved
      </p>
      <Button variant="outline" size="sm" onclick={() => (value = { type: "value", value: "" })}
        >Replace</Button
      >
    </div>
  {:else}<label for={id} class="text-muted-foreground text-xs">Client secret</label><Input
      {id}
      type="password"
      bind:value={value.value}
      autocomplete="new-password"
      required
      class="h-10"
    />{/if}
</fieldset>
