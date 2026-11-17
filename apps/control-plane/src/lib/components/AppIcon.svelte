<script lang="ts">
  import Layers2 from "@lucide/svelte/icons/layers-2";

  let { appId, deploymentId }: { appId: string; deploymentId: string | null } = $props();

  const source = $derived(
    deploymentId ? `/api/v1/apps/${appId}/icon?deployment=${deploymentId}` : null,
  );

  let loaded = $state<string | null>(null);

  let failed = $state<string | null>(null);
</script>

<span
  class="text-muted-foreground relative grid size-6 shrink-0 place-items-center"
  aria-hidden="true"
>
  {#if source && source !== failed}
    {#key source}
      <img
        src={source}
        alt=""
        width="24"
        height="24"
        class="absolute size-6 object-contain"
        class:invisible={loaded !== source}
        onload={(event) => {
          loaded = event.currentTarget.getAttribute("src");
        }}
        onerror={(event) => {
          failed = event.currentTarget.getAttribute("src");
        }}
      />
    {/key}
  {/if}
  {#if !source || source !== loaded || source === failed}<Layers2 class="size-4" />{/if}
</span>
