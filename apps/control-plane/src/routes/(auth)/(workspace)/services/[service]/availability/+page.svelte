<script lang="ts">
  import { setServiceAccess } from "#lib/services.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "@platform/ui/button";
  import { Label } from "@platform/ui/label";
  import { NativeSelect } from "@platform/ui/native-select";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{data.service.displayName} availability · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-8">
  <a
    class="text-muted-foreground block text-sm underline underline-offset-4"
    href={`/services/${data.service.appId}`}>Back to {data.service.displayName}</a
  >
  <PageHeading
    title="API availability"
    description={`Choose who can connect ${data.service.displayName} to their apps.`}
  />
  {#if data.saved}<Feedback>Availability saved.</Feedback>{/if}
  <form {...setServiceAccess} class="space-y-6">
    <OrganizationField field={setServiceAccess.fields.organizationId} />
    <input {...setServiceAccess.fields.appId.as("hidden", data.service.appId)} />
    <div class="space-y-2">
      <Label for="availability">Who can connect this API?</Label>
      <NativeSelect
        id="availability"
        {...setServiceAccess.fields.accessMode.as("select", data.service.accessMode)}
        class="w-full"
      >
        <option value="approval_required">Administrator approval required</option>
        <option value="organization">Everyone in this organization</option>
      </NativeSelect>
    </div>
    <p class="text-muted-foreground text-sm leading-6">
      Members can only connect apps they manage. This setting applies to all entrypoints of this
      API. Existing connections are kept when you change availability.
    </p>
    <FormIssues issues={setServiceAccess.fields.allIssues()} />
    <div class="flex flex-wrap gap-3">
      <Button type="submit" disabled={setServiceAccess.pending > 0}>Save availability</Button>
      <Button variant="ghost" href={`/services/${data.service.appId}`}>Cancel</Button>
    </div>
  </form>
</div>
