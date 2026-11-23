<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import { getAppContext } from "#lib/app-context";
  import { getAppServices, getServiceDescription } from "#lib/services.remote";
  import ServiceReference from "#shadcn/components/ServiceReference.svelte";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const context = getAppContext();

  const catalog = $derived(await getAppServices({ organizationId: workspace.organizationId }));

  // Only a deployed app has an API to describe.
  const service = $derived(
    await getServiceDescription({
      organizationId: workspace.organizationId,
      service: context.data.app.id,
    }).catch((cause: unknown) => {
      if (isHttpError(cause, 404)) return null;
      throw cause;
    }),
  );
</script>

{#if service}
  <ServiceReference {service} admin={catalog.admin} />
{:else}
  <p class="text-muted-foreground text-sm">Deploy this app to see what it exposes.</p>
{/if}
