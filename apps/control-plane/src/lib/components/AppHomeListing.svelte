<script lang="ts">
  import type { getAppDetails } from "#lib/apps.remote";
  import { setCatalogListing } from "#lib/catalog.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import { Label } from "@platform/ui/label";
  import { Switch } from "@platform/ui/switch";

  // Whether an app appears on Home. Who can open it is decided by its access rules.
  let { data, search }: { data: Awaited<ReturnType<typeof getAppDetails>>; search: string } =
    $props();

  const app = $derived(data.app);

  const deployed = $derived(app.state === "active" && app.activeDeploymentId !== null);

  // The switch shows the choice at once; a save that fails returns it to the saved state.
  let shown = $derived(app.catalogListed);

  let form = $state<HTMLFormElement>();
</script>

<section id="home" aria-labelledby="home-heading" class="mt-10 max-w-3xl border-t pt-8">
  <form
    bind:this={form}
    {...setCatalogListing.enhance(async ({ submit }) => {
      if (!(await submit())) shown = app.catalogListed;
    })}
    class="flex items-start justify-between gap-4"
  >
    <OrganizationField field={setCatalogListing.fields.organizationId} />
    <input {...setCatalogListing.fields.appId.as("hidden", app.id)} />
    <input {...setCatalogListing.fields.search.as("hidden", search)} />
    <input
      {...setCatalogListing.fields.listed.as("hidden", app.catalogListed ? "false" : "true")}
    />
    <div class="space-y-2">
      <h2 id="home-heading" class="text-base font-semibold">
        <Label for="show-on-home" class="text-base font-semibold">Show on Home</Label>
      </h2>
      <p class="text-muted-foreground text-sm leading-6">
        {#if !deployed}
          Available after the app's first successful deployment.
        {:else if data.access.canManage}
          Everyone in the organization finds this app on Home. The rules above still decide who can
          open it.
        {:else}
          Only the app's owner and administrators can change this.
        {/if}
      </p>
      <FormIssues issues={setCatalogListing.fields.allIssues()} />
    </div>
    <Switch
      id="show-on-home"
      bind:checked={shown}
      disabled={!deployed || !data.access.canManage || setCatalogListing.pending > 0}
      onCheckedChange={() => form?.requestSubmit()}
    />
  </form>
</section>
