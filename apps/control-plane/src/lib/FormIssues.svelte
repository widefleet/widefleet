<script lang="ts">
  import type { RemoteFormIssue } from "$app/server";
  import Feedback from "#shadcn/components/Feedback.svelte";

  let { issues }: { issues: RemoteFormIssue[] | undefined } = $props();
</script>

{#if issues?.length}
  <Feedback kind="error"
    >{#each issues as issue}<p>{issue.message}</p>{/each}</Feedback
  >
{/if}
