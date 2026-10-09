<script lang="ts">
  import { getAppDetails, rollbackApp } from "#lib/apps.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import History from "@lucide/svelte/icons/history";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import Feedback from "./Feedback.svelte";
  import DeploymentStatus from "./DeploymentStatus.svelte";
  import EmptyState from "./EmptyState.svelte";

  let {
    data,
    search,
    requestId,
    rollbackPending,
    submitRollback,
  }: {
    data: Awaited<ReturnType<typeof getAppDetails>>;
    search: string;
    requestId: string;
    rollbackPending: boolean;
    submitRollback: (submission: { submit: () => Promise<boolean> }) => Promise<void>;
  } = $props();

  const dates = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
</script>

<section aria-labelledby="deployments-heading">
  <h2 id="deployments-heading" class="text-base font-semibold">Deployment history</h2>
  <p class="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
    Every published version in one place. Restoring a version publishes its saved code again; your
    data stays as it is.
  </p>
  {#if data.history.length === 0}
    <EmptyState
      title="No deployments yet"
      description="Publish your first version with the CLI. Find the steps for this app in the overview."
      >{#snippet icon()}<History />{/snippet}<Button href={`/apps/${data.app.id}`} variant="outline"
        >View deployment instructions</Button
      ></EmptyState
    >
  {:else}
    <ol class="mt-6 divide-y rounded-xl border">
      {#each data.history as deployment (deployment.id)}
        <li class="p-5 sm:p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-3">
                <DeploymentStatus
                  status={deployment.status}
                />{#if deployment.id === data.app.activeDeploymentId}<Badge
                    variant="secondary"
                    class="font-normal">Current version</Badge
                  >{/if}
              </div>
              <p class="text-muted-foreground text-xs">
                <time datetime={deployment.createdAt}
                  >{dates.format(new Date(deployment.createdAt))} UTC</time
                >
              </p>
              <code
                class="text-muted-foreground block text-[11px] wrap-anywhere"
                title="Deployment ID">{deployment.id}</code
              >
            </div>
            {#if deployment.status === "succeeded" && deployment.id !== data.app.activeDeploymentId && data.app.state !== "deleting"}
              {@const rollback = rollbackApp.for(deployment.id)}
              <form {...rollback.enhance(submitRollback)} class="space-y-3">
                <input {...rollback.fields.appId.as("hidden", data.app.id)} /><input
                  {...rollback.fields.search.as("hidden", search)}
                /><input
                  {...rollback.fields.artifactId.as("hidden", deployment.artifactId)}
                /><input {...rollback.fields.requestId.as("hidden", requestId)} />
                <FormIssues issues={rollback.fields.allIssues()} />
                <Button type="submit" variant="outline" disabled={rollbackPending}
                  ><RotateCcw />{rollback.pending
                    ? "Requesting restoration …"
                    : "Restore version"}</Button
                >
                {#if rollback.result?.accepted}<Feedback
                    >Restoration requested. Follow its progress in the deployment list.</Feedback
                  >{/if}
              </form>
            {/if}
          </div>
          {#if deployment.message}<div
              class={`mt-4 rounded-lg px-3 py-2 text-sm leading-6 wrap-anywhere ${deployment.status === "failed" ? "bg-destructive/5 text-destructive" : "bg-muted/50 text-muted-foreground"}`}
            >
              {deployment.message}
            </div>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
