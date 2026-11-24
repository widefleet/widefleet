<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import DeploymentStatus from "#shadcn/components/DeploymentStatus.svelte";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Globe from "@lucide/svelte/icons/globe";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const app = getAppContext();

  const data = $derived(app.data);

  const latest = $derived(data.history[0]);
</script>

<div class="space-y-8">
  {#if latest}<section class="rounded-xl border p-5 sm:p-6">
      <div class="mb-5 flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">Latest deployment</h2>
        <a
          href={workspace.path(`/apps/${data.app.id}/deployments`)}
          class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >View history<ArrowRight class="size-3" /></a
        >
      </div>
      <DeploymentStatus status={latest.status} />
      <p class="text-muted-foreground mt-2 text-xs">
        {new Intl.DateTimeFormat("en-GB", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "UTC",
        }).format(new Date(latest.createdAt))} UTC
      </p>
      {#if latest.message}<p class="text-muted-foreground mt-4 text-sm leading-6 wrap-anywhere">
          {latest.message}
        </p>{/if}
    </section>{/if}
  <section class="min-w-0 rounded-xl border p-5 sm:p-6">
    <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold">
      <Globe class="text-muted-foreground size-4" />App address
    </h2>
    <CopyValue value={data.app.url} label="Copy app address" />
    <p class="text-muted-foreground mt-3 text-xs leading-5">
      {data.app.state === "active"
        ? "Users sign in with their company accounts."
        : "Available after the first successful deployment."}
    </p>
  </section>
</div>
