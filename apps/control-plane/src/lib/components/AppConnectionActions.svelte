<script lang="ts">
  import { connectApp, disconnectApp } from "#lib/services.remote";
  import type { capabilityGrant } from "@platform/contracts";
  import type { z } from "zod";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";

  let {
    appId,
    binding,
    grant,
    failed,
    pending,
  }: {
    appId: string;
    binding: string;
    grant?: z.infer<typeof capabilityGrant> | undefined;
    failed: boolean;
    pending: boolean;
  } = $props();

  const removal = $derived(disconnectApp.for(binding));

  const retry = $derived(connectApp.for(`retry-${binding}`));
</script>

<div class="mt-4 space-y-3">
  {#if grant && failed}
    <form {...retry}>
      <OrganizationField field={retry.fields.organizationId} />
      <input {...retry.fields.appId.as("hidden", appId)} />
      <input {...retry.fields.targetApp.as("hidden", grant.app)} />
      <input {...retry.fields.entrypoint.as("hidden", grant.entrypoint)} />
      <input {...retry.fields.binding.as("hidden", binding)} />
      <FormIssues issues={retry.fields.allIssues()} />
      <Button type="submit" size="sm" variant="outline" disabled={retry.pending > 0}
        >Retry connection {binding}</Button
      >
    </form>
  {/if}
  <form {...removal}>
    <OrganizationField field={removal.fields.organizationId} />
    <input {...removal.fields.appId.as("hidden", appId)} />
    <input {...removal.fields.binding.as("hidden", binding)} />
    <FormIssues issues={removal.fields.allIssues()} />
    <Button
      type="submit"
      size="sm"
      variant="outline"
      disabled={removal.pending > 0 || (!grant && pending)}
      >{grant ? "Disconnect" : failed ? "Retry disconnection" : "Removal pending"}</Button
    >
  </form>
</div>
