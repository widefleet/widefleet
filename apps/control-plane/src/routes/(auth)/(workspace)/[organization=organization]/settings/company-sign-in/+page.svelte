<script lang="ts">
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { onMount } from "svelte";
  import { settingsInput } from "@platform/contracts";
  import { getSettings } from "#lib/settings.remote";
  import { SettingsWriter } from "#lib/sso-setup.svelte";
  import { Button } from "@platform/ui/button";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import CompanySsoConnection from "#shadcn/components/sso/CompanySsoConnection.svelte";
  import RestartDialog from "#shadcn/components/sso/RestartDialog.svelte";
  import type { PageData } from "./$types";

  const workspace = getWorkspaceContext();

  let { data: route }: { data: PageData } = $props();

  const settings = $derived(getSettings({ organizationId: workspace.organizationId }));

  const data = $derived(
    await settings.catch((cause: unknown) => {
      if (settings.error && settings.error.status >= 500 && settings.current)
        return settings.current;
      throw cause;
    }),
  );

  const view = $derived(data.view);

  const readonly = $derived(view.settings.externallyManaged);

  const writer = new SettingsWriter(
    () => workspace.organizationId,
    () => {},
  );

  const useWidefleet = () =>
    writer.save(() =>
      settingsInput.parse({ ...view.settings, sso: null, directory: null, embeddingOrigins: [] }),
    );

  onMount(() => {
    let refreshing = false;

    const timer = setInterval(async () => {
      if (
        view.activation.state !== "applying" ||
        refreshing ||
        document.visibilityState !== "visible"
      )
        return;
      refreshing = true;

      try {
        await settings.refresh();
      } catch {
        // The query exposes the failure and polling retries while activation remains pending.
      } finally {
        refreshing = false;
      }
    }, 2000);

    return () => clearInterval(timer);
  });
</script>

<svelte:head><title>Company sign-in · Widefleet</title></svelte:head>
<PageHeading
  title="Company sign-in"
  description="Choose how members sign in to Widefleet and your apps."
/>
<div class="mt-8 max-w-2xl space-y-6">
  {#if writer.error}<Feedback kind="error">{writer.error}</Feedback>{/if}
  {#if view.error}<Feedback kind="error">{view.error}</Feedback>{/if}
  {#if view.sso}
    <CompanySsoConnection
      {view}
      organizationId={workspace.organizationId}
      platformUrl={data.platformUrl}
      linked={data.linked}
      tested={data.tested}
      emailSignIn={data.emailSignIn}
      loginFailed={route.loginFailed}
    />
  {:else}
    <section class="rounded-xl border" aria-label="Company SSO">
      <EmptyState
        title="Company SSO"
        description="Let members sign in with Microsoft Entra, Google Workspace or another OpenID Connect provider."
        >{#snippet icon()}<KeyRound />{/snippet}<Button
          href={workspace.path("/settings/company-sign-in/setup")}
          disabled={readonly}>Set up company SSO</Button
        ></EmptyState
      >
    </section>
  {/if}

  {#if data.emailSignIn && !view.sso}
    <section class="space-y-3 rounded-xl border p-6" aria-labelledby="app-sign-in-title">
      <h2 id="app-sign-in-title" class="text-base font-semibold">App sign-in</h2>
      <p class="text-muted-foreground text-sm">
        Until company SSO is active, members sign in to your apps with Widefleet.
      </p>
      <Feedback kind={view.activation.state === "active" ? "success" : "info"}>
        {view.activation.state === "active"
          ? "Widefleet app sign-in is active."
          : view.activation.message}
      </Feedback>
      {#if view.activation.state !== "active"}
        <Button variant="outline" disabled={readonly || writer.busy} onclick={useWidefleet}
          >Activate Widefleet sign-in</Button
        >
      {/if}
    </section>
  {/if}
</div>
<RestartDialog {writer} />
