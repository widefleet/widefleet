<script lang="ts">
  import { page } from "$app/state";
  import { getAppContext } from "#lib/app-context";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import DeploymentStatus from "#shadcn/components/DeploymentStatus.svelte";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Globe from "@lucide/svelte/icons/globe";
  import CircleCheck from "@lucide/svelte/icons/circle-check";

  const app = getAppContext();

  const data = $derived(app.data);

  const latest = $derived(data.history[0]);
</script>

<div class="space-y-8">
  {#if data.app.parentId}<a
      href={`/apps/${data.app.parentId}`}
      class="bg-muted/40 hover:bg-muted/70 flex items-center gap-3 rounded-lg border p-4 text-sm"
      ><GitBranch class="text-muted-foreground size-4" /><span>Back to original app</span
      ><ArrowRight class="text-muted-foreground ml-auto size-4" /></a
    >{/if}
  {#if data.app.state !== "deleting" && !data.app.activeDeploymentId}
    <section class="overflow-hidden rounded-xl border">
      <div class="bg-primary/3 border-b px-5 py-5 sm:px-6">
        <div class="mb-3 flex items-center gap-2 text-xs font-medium text-primary">
          <CircleCheck class="size-4" />App created
        </div>
        <h2 class="text-lg font-semibold tracking-tight">Ready for your first deployment.</h2>
        <p class="text-muted-foreground mt-2 max-w-xl text-sm leading-6">
          No deployments yet. Connect your CLI and publish your project. Its status will appear here
          when it's ready.
        </p>
      </div>
      <ol class="divide-y">
        <li class="flex gap-4 p-5 sm:p-6">
          <span
            class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
            >1</span
          >
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium">Connect to your workspace</h3>
            <p class="text-muted-foreground mt-1 mb-3 text-xs leading-5">
              Run this command in your terminal and confirm the device code in your browser.
            </p>
            <CopyValue
              value={`widefleet --url '${page.url.origin}' login`}
              label="Copy sign-in command"
            />
          </div>
        </li>
        <li class="flex gap-4 p-5 sm:p-6">
          <span
            class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
            >2</span
          >
          <div class="min-w-0 flex-1">
            <h3 class="text-sm font-medium">Deploy your project</h3>
            <p class="text-muted-foreground mt-1 mb-3 text-xs leading-5">
              Run this from your Widefleet project directory. The command deploys directly to this
              app.
            </p>
            <CopyValue
              value={`widefleet --url '${page.url.origin}' deploy ${data.app.id}`}
              label="Copy deployment command"
            />
            <details class="mt-4">
              <summary class="text-muted-foreground text-xs">No project yet?</summary>
              <p class="text-muted-foreground mt-3 mb-2 text-xs leading-5">
                You'll need the Widefleet CLI, Node.js and pnpm installed. Create a project in an
                empty directory and install its dependencies.
              </p>
              <CopyValue
                value={`widefleet init ${data.app.slug}\ncd ${data.app.slug}\npnpm install --frozen-lockfile`}
                label="Copy project commands"
              />
            </details>
          </div>
        </li>
        <li class="flex gap-4 p-5 sm:p-6">
          <span
            class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
            >3</span
          >
          <div>
            <h3 class="text-sm font-medium">Follow progress</h3>
            <p class="text-muted-foreground mt-1 text-xs leading-5">
              The status updates automatically. Your app will be available after a successful
              deployment.
            </p>
            <Button
              href={`/apps/${data.app.id}/deployments`}
              variant="link"
              class="mt-2 h-auto px-0">View deployments<ArrowRight /></Button
            >
          </div>
        </li>
      </ol>
    </section>
  {/if}
  {#if latest}<section class="rounded-xl border p-5 sm:p-6">
      <div class="mb-5 flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">Latest deployment</h2>
        <a
          href={`/apps/${data.app.id}/deployments`}
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
  <div class="grid gap-6 lg:grid-cols-2">
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
    {#if data.app.state !== "deleting" && !data.app.parentId}<section
        class="rounded-xl border p-5 sm:p-6"
      >
        <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold">
          <GitBranch class="text-muted-foreground size-4" />Try ideas safely
        </h2>
        <p class="text-muted-foreground text-xs leading-6">
          Test changes in a preview with its own address and data.
        </p>
        <Button href={`/apps/new?parent=${data.app.id}`} variant="outline" class="mt-4"
          >Create preview<ArrowUpRight /></Button
        >
      </section>{/if}
  </div>
</div>
