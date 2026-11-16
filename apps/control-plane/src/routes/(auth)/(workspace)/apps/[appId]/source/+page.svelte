<script lang="ts">
  import { page } from "$app/state";
  import { getAppSource } from "#lib/apps.remote";
  import { getAppContext } from "#lib/app-context";
  import CopyValue from "#shadcn/components/CopyValue.svelte";

  const context = getAppContext();

  const app = $derived(context.data.app);

  const source = $derived(await getAppSource({ appId: app.id }));

  const repository = $derived(source.repository);

  const deployed = $derived(source.deployed);

  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  const cli = $derived(
    `widefleet --url ${quote(page.url.origin)} --organization ${quote(app.organizationId)}`,
  );
</script>

<div class="max-w-2xl space-y-8">
  <section>
    <h2 class="text-base font-semibold">Source code</h2>
    {#if !source.supported}
      <p class="text-muted-foreground mt-2 text-sm">
        This installation does not provide Git repositories.
      </p>
    {:else if source.error}
      <p role="alert" class="text-destructive mt-2 text-sm leading-6">
        {source.error}. Refresh to try again. Your app settings and deployment history remain
        available.
      </p>
    {:else if !source.available}
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        No source has been saved{repository ? ` on ${repository.branch}` : ""} yet.
        {#if app.parentId && !repository}Deploy a Git preview from your work branch to save its
          code.
        {:else}Deploy from your project to save its code, or connect an existing Git repository.{/if}
      </p>
      <div class="mt-4">
        <CopyValue
          value={app.parentId && !repository
            ? `${cli} preview --app ${app.parentId}`
            : `${cli} source connect --app ${app.id}`}
          label={app.parentId && !repository ? "Copy preview command" : "Copy Git setup command"}
        />
      </div>
    {:else}
      <p class="text-muted-foreground mt-2 mb-4 text-sm leading-6">
        Clone the saved code to continue working locally, with an agent or in CI.
      </p>
      <CopyValue value={`${cli} source clone ${app.id} ${app.slug}`} label="Copy clone command" />
    {/if}
    {#if app.parentId && repository}<p class="text-muted-foreground mt-3 text-xs leading-6">
        This preview uses a branch in the main app’s repository.
      </p>{/if}
  </section>
  {#if repository}
    <section class="space-y-5">
      <div>
        <h3 class="mb-2 text-sm font-medium">Git URL</h3>
        <CopyValue value={repository.url} label="Copy Git URL" />
      </div>
      <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <div>
          <dt class="text-muted-foreground text-xs">Branch</dt>
          <dd class="mt-1.5 font-mono text-sm wrap-anywhere">{repository.branch}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground text-xs">Latest saved commit</dt>
          <dd class="mt-1.5 font-mono text-xs leading-6 wrap-anywhere">
            {repository.commit ?? "No commits"}
          </dd>
        </div>
        <div class="sm:col-span-2">
          <dt class="text-muted-foreground text-xs">Deployed source</dt>
          <dd class="mt-1.5 text-sm wrap-anywhere">
            {#if deployed}<span class="block font-mono text-xs leading-6">{deployed.commit}</span
              ><span class="text-muted-foreground">Branch: {deployed.branch}</span>{:else}The active
              deployment has no saved source reference.{/if}
          </dd>
        </div>
        {#if deployed && deployed.directory !== "."}<div class="sm:col-span-2">
            <dt class="text-muted-foreground text-xs">Project directory</dt>
            <dd class="mt-1.5 font-mono text-sm wrap-anywhere">{deployed.directory}</dd>
          </div>{/if}
      </dl>
      <p class="text-muted-foreground text-xs leading-6">
        Pushing code saves it. Run <code>widefleet deploy</code>{app.parentId
          ? " or widefleet preview"
          : ""} to publish a new version.
      </p>
    </section>
  {/if}
</div>
