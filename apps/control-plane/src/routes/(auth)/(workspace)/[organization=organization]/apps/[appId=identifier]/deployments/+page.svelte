<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import { Button } from "@platform/ui/button";
  import AppDeployments from "#shadcn/components/AppDeployments.svelte";
  import AppSource from "#shadcn/components/AppSource.svelte";

  const app = getAppContext();

  const data = $derived(app.data);
</script>

<AppDeployments
  {data}
  search={app.search}
  requestId={app.requestId}
  rollbackPending={app.rollbackPending}
  submitRollback={app.submitRollback}
/>
{#if data.source.supported}<div class="mt-10 border-t pt-8">
    <!-- The saved code comes from the Git host, so the deployments above do not wait for it. -->
    <svelte:boundary>
      <AppSource />
      {#snippet pending()}
        <h2 class="text-base font-semibold">Source code</h2>
        <p class="text-muted-foreground mt-2 text-sm">Loading the saved code …</p>
        <noscript
          ><p class="text-muted-foreground mt-2 text-sm">
            This section needs JavaScript.
          </p></noscript
        >
      {/snippet}
      <!-- A failure stays in this section, so the history and the rollback above remain usable. -->
      {#snippet failed(_error, reset)}
        <h2 class="text-base font-semibold">Source code</h2>
        <p role="alert" class="text-destructive mt-2 text-sm leading-6">
          The saved code could not be loaded. Your deployment history remains available.
        </p>
        <Button variant="outline" class="mt-4" onclick={reset}>Try again</Button>
      {/snippet}
    </svelte:boundary>
  </div>{/if}
