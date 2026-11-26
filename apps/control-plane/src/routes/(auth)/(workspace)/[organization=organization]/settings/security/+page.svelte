<script lang="ts">
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { getSettings, setBrowserWorkers } from "#lib/settings.remote";
  import { failureMessage } from "#lib/sso-setup.svelte";
  import { Switch } from "@platform/ui/switch";
  import { Label } from "@platform/ui/label";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";

  const workspace = getWorkspaceContext();

  const settings = $derived(getSettings({ organizationId: workspace.organizationId }));

  const data = $derived(
    await settings.catch((cause: unknown) => {
      if (settings.error && settings.error.status >= 500 && settings.current)
        return settings.current;
      throw cause;
    }),
  );

  const readonly = $derived(data.view.settings.externallyManaged);

  let message = $state("");

  let busy = $state(false);

  let enabled = $derived(data.view.settings.allowBrowserWorkers ?? false);

  const toggle = async (next: boolean) => {
    enabled = next;
    busy = true;
    message = "";

    try {
      await setBrowserWorkers({
        enabled: next,
        organizationId: workspace.organizationId,
      });
    } catch (cause) {
      enabled = data.view.settings.allowBrowserWorkers ?? false;
      message = failureMessage(cause, "Could not apply the change.");
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Security · Widefleet</title></svelte:head>
<PageHeading title="Security" />
<div class="mt-8 max-w-2xl space-y-6">
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if data.view.error}<Feedback kind="error">{data.view.error}</Feedback>{/if}
  <section class="border-t py-5">
    <div class="flex items-center justify-between gap-4">
      <Label for="browser-workers" class="text-base font-semibold">Allow browser workers</Label>
      <Switch
        id="browser-workers"
        checked={enabled}
        onCheckedChange={toggle}
        disabled={busy || readonly}
        aria-describedby="worker-access"
      />
    </div>
    <p id="worker-access" class="text-muted-foreground mt-2 max-w-prose text-sm leading-6">
      Apps can run background tasks and work offline. Pages served by a service worker can connect
      to destinations outside the app’s network permissions.
    </p>
    {#if readonly}
      <p class="text-muted-foreground mt-2 text-sm">
        This setting is managed through the API or CLI.
      </p>
    {/if}
    <details class="text-muted-foreground mt-3 text-sm">
      <summary class="cursor-pointer">What happens when I turn this off?</summary>
      <p class="mt-2 max-w-prose leading-6">
        Widefleet blocks new registrations. Previously installed service workers can remain active
        on users’ devices.
      </p>
    </details>
  </section>
</div>
