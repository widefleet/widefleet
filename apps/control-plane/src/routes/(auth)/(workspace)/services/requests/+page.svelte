<script lang="ts">
  import { getConnectionRequests, decideConnectionRequest } from "#lib/services.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "@platform/ui/button";
  import { Badge } from "@platform/ui/badge";

  const requests = $derived(await getConnectionRequests());

  const labels = { pending: "Awaiting approval", approved: "Approved", rejected: "Rejected" };

  const entries = $derived(
    [...requests.entries].sort(
      (a, b) => Number(b.status === "pending") - Number(a.status === "pending"),
    ),
  );
</script>

<svelte:head><title>Connection requests · Widefleet</title></svelte:head>
<div class="max-w-3xl space-y-6">
  <a class="block text-sm underline underline-offset-4" href="/services">Back to app APIs</a>
  <div>
    <h1 class="text-xl font-semibold">Connection requests</h1>
    <p class="text-muted-foreground mt-2 text-sm">
      {requests.admin
        ? "Review requests to connect apps to APIs in your organization."
        : "Track your requests to connect apps to APIs."}
    </p>
  </div>
  <div class="divide-y">
    {#each entries as entry (entry.id)}
      <section class="space-y-3 py-5" aria-label={`${entry.appName} to ${entry.serviceName}`}>
        <div class="flex flex-wrap items-start justify-between gap-2">
          <h2 class="min-w-0 font-medium wrap-anywhere">{entry.appName} → {entry.serviceName}</h2>
          <Badge variant="outline">{labels[entry.status]}</Badge>
        </div>
        <p class="text-muted-foreground text-sm wrap-anywhere">
          <code>{entry.binding}</code> · {entry.entrypoint}
        </p>
        {#if requests.admin}<p class="text-muted-foreground text-sm">
            Requested by {entry.requesterName}
          </p>{/if}
        {#if entry.status === "approved"}
          <p class="text-muted-foreground text-sm">
            Approved for connection. Check the app’s connections for activation status.
          </p>
        {/if}
        <a
          class="block text-sm underline underline-offset-4"
          href={`/apps/${entry.appId}/connections`}>View app connections</a
        >
        {#if requests.admin && entry.status === "pending"}
          {@const decision = decideConnectionRequest.for(entry.id)}
          <form {...decision} class="space-y-3">
            <OrganizationField field={decision.fields.organizationId} />
            <input {...decision.fields.requestId.as("hidden", entry.id)} />
            <FormIssues issues={decision.fields.allIssues()} />
            <div class="flex flex-wrap gap-2">
              <Button
                {...decision.fields.decision.as("submit", "approve")}
                disabled={decision.pending > 0}>Approve and connect</Button
              >
              <Button
                variant="outline"
                {...decision.fields.decision.as("submit", "reject")}
                disabled={decision.pending > 0}>Reject</Button
              >
            </div>
          </form>
        {/if}
      </section>
    {:else}
      <p class="text-muted-foreground py-8 text-sm">No connection requests yet.</p>
    {/each}
  </div>
</div>
