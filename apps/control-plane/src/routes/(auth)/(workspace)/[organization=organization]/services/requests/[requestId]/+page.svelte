<script lang="ts">
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import { Button } from "@platform/ui/button";
  import { getConnectionRequest } from "#lib/services.remote";
  import type { PageProps } from "./$types";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let { params }: PageProps = $props();

  const data = $derived({
    request: await getConnectionRequest({
      organizationId: workspace.organizationId,
      requestId: params.requestId,
    }),
  });

  const titles = {
    pending: "Request submitted",
    approved: "Request approved",
    rejected: "Request rejected",
  };

  const descriptions = {
    pending:
      "An organization administrator will review your request. Your app has not been connected yet.",
    approved:
      "The connection has been approved. Check your app’s connections for its activation status.",
    rejected: "This request was rejected. You can choose another API or submit a new request.",
  };
</script>

<svelte:head><title>{titles[data.request.status]} · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-8">
  <PageHeading
    title={titles[data.request.status]}
    description={descriptions[data.request.status]}
  />
  <dl class="space-y-4 text-sm">
    <div>
      <dt class="text-muted-foreground">Your app</dt>
      <dd class="mt-1 font-medium wrap-anywhere">{data.request.appName}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">API</dt>
      <dd class="mt-1 font-medium wrap-anywhere">
        {data.request.serviceName} · {data.request.entrypoint}
      </dd>
    </div>
    <div>
      <dt class="text-muted-foreground">Binding</dt>
      <dd class="mt-1 font-mono wrap-anywhere">{data.request.binding}</dd>
    </div>
  </dl>
  <div class="flex flex-wrap gap-3">
    <Button href={workspace.path("/services/requests")}>View requests</Button>
    <Button variant="outline" href={workspace.path(`/apps/${data.request.appId}/connections`)}
      >View app connections</Button
    >
  </div>
</div>
