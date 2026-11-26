<script lang="ts">
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { getSettings, setBrowserWorkers } from "#lib/settings.remote";
  import { failureMessage } from "#lib/sso-setup.svelte";
  import { Button } from "@platform/ui/button";
  import * as Dialog from "@platform/ui/dialog";
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

  let confirmOpen = $state(false);

  let trigger = $state<HTMLElement | null>(null);

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
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-base font-semibold">Browser workers</h2>
        <p class="text-muted-foreground mt-1 text-sm leading-6">
          {enabled ? "Allowed" : "Blocked"} for apps in this organization.
        </p>
      </div>
      <Button
        bind:ref={trigger}
        variant="outline"
        disabled={busy || readonly}
        onclick={() => (enabled ? toggle(false) : (confirmOpen = true))}
      >
        {enabled ? "Disable" : "Enable…"}
      </Button>
    </div>
    {#if readonly}
      <p class="text-muted-foreground mt-2 text-sm">
        This setting is managed through the API or CLI.
      </p>
    {/if}
  </section>
</div>

<Dialog.Root bind:open={confirmOpen}>
  <Dialog.Content
    class="sm:max-w-md"
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      trigger?.focus();
    }}
  >
    <Dialog.Header>
      <Dialog.Title>Allow browser workers?</Dialog.Title>
      <Dialog.Description>
        Apps in this organization will be able to install service workers on users’ devices. Turning
        this off later blocks new installations. Previously installed service workers can stay
        active.
      </Dialog.Description>
    </Dialog.Header>
    <p class="text-muted-foreground text-sm">
      Pages served by a service worker can connect to destinations outside the app’s network
      permissions.
    </p>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (confirmOpen = false)}>Cancel</Button>
      <Button
        onclick={() => {
          confirmOpen = false;
          void toggle(true);
        }}>Allow browser workers</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
