<script lang="ts">
  import CopyButton from "./CopyButton.svelte";

  let { name, value }: { name: string; value: string } = $props();
</script>

<dl
  class="bg-muted/50 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 rounded-lg border px-4 py-2 text-xs"
>
  <dt class="text-muted-foreground py-2">Type</dt>
  <dd class="col-span-2 py-2 font-mono">TXT</dd>
  <dt class="text-muted-foreground py-2">Name</dt>
  <dd class="font-mono wrap-anywhere">{name}</dd>
  <dd><CopyButton value={name} label="Copy record name" /></dd>
  <dt class="text-muted-foreground py-2">Value</dt>
  <dd class="font-mono wrap-anywhere">{value}</dd>
  <dd><CopyButton {value} label="Copy record value" /></dd>
</dl>
