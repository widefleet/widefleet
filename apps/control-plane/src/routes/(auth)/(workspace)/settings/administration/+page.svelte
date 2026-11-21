<script lang="ts">
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { getSettings, setExternalManagement } from "#lib/settings.remote";
  import { failureMessage } from "#lib/sso-setup.svelte";
  import { Button } from "@platform/ui/button";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";

  const workspace = getWorkspaceContext();

  const settings = $derived(getSettings());

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

  const toggleExternal = async () => {
    busy = true;
    message = "";

    try {
      await setExternalManagement({ enabled: !readonly, organizationId: workspace.organizationId });
    } catch (cause) {
      message = failureMessage(cause, "Could not apply the change.");
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Administration · Widefleet</title></svelte:head>
<PageHeading title="Administration" />
<div class="mt-8 max-w-2xl space-y-6">
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if data.view.error}<Feedback kind="error">{data.view.error}</Feedback>{/if}
  <section class="space-y-4 rounded-xl border p-6">
    <h2 class="text-base font-semibold">Manage configuration</h2>
    <p class="text-muted-foreground text-sm">
      {readonly
        ? "Settings are managed through the API or CLI. Enable browser editing to make changes here."
        : "You can manage settings here, through the API or through the CLI."}
    </p>
    <Button variant="outline" disabled={busy} onclick={toggleExternal}
      >{readonly ? "Enable browser editing" : "Manage settings externally"}</Button
    >
  </section>
</div>
