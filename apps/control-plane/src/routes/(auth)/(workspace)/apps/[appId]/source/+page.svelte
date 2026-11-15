<script lang="ts">
  import { page } from "$app/state";
  import { getAppContext } from "#lib/app-context";
  import { setupAppSource } from "#lib/apps.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";

  const context = getAppContext();

  const app = $derived(context.data.app);

  const source = $derived(context.data.source);

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
    {:else if !source.available}
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        No source has been saved{repository ? ` on ${repository.branch}` : ""} yet. Deploy from your project
        to save its code, or connect an existing Git repository.
      </p>
      <div class="mt-4">
        <CopyValue value={`${cli} source connect --app ${app.id}`} label="Copy Git setup command" />
      </div>
    {:else}
      <p class="text-muted-foreground mt-2 mb-4 text-sm leading-6">
        Clone the saved code to continue working locally, with an agent or in CI.
      </p>
      <CopyValue value={`${cli} source clone ${app.id} ${app.slug}`} label="Copy clone command" />
    {/if}
    {#if app.parentId && source.supported}<p class="text-muted-foreground mt-3 text-xs leading-6">
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
  {#if source.supported && app.state !== "deleting"}
    <section>
      {#if repository}
        <details>
          <summary class="text-sm font-medium">Change source branch</summary>
          <form {...setupAppSource} class="mt-4 max-w-sm space-y-4">
            <OrganizationField field={setupAppSource.fields.organizationId} />
            <input {...setupAppSource.fields.appId.as("hidden", app.id)} />
            <div class="space-y-2">
              <label for="source-branch" class="text-sm">Branch</label><Input
                id="source-branch"
                {...setupAppSource.fields.branch.as("text", repository.branch)}
                required
              />
            </div>
            <FormIssues issues={setupAppSource.fields.allIssues()} />
            <Button type="submit" variant="outline" disabled={setupAppSource.pending > 0}
              >{setupAppSource.pending ? "Saving …" : "Save branch"}</Button
            >
          </form>
        </details>
      {:else}
        <form {...setupAppSource} class="space-y-4">
          <OrganizationField field={setupAppSource.fields.organizationId} />
          <input {...setupAppSource.fields.appId.as("hidden", app.id)} />
          <FormIssues issues={setupAppSource.fields.allIssues()} />
          <Button type="submit" variant="outline" disabled={setupAppSource.pending > 0}
            >{setupAppSource.pending ? "Creating …" : "Create Git repository"}</Button
          >
        </form>
      {/if}
    </section>
  {/if}
</div>
