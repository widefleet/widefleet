<script lang="ts">
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { onMount } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { settingsInput } from "@platform/contracts";
  import { getSettings, setExternalManagement } from "#lib/settings.remote";
  import { failureMessage, SettingsWriter } from "#lib/sso-setup.svelte";
  import { Button } from "@platform/ui/button";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import SettingsTabs from "#shadcn/components/SettingsTabs.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import CompanySsoConnection from "#shadcn/components/sso/CompanySsoConnection.svelte";
  import RestartDialog from "#shadcn/components/sso/RestartDialog.svelte";
  import type { PageData } from "./$types";

  const workspace = getWorkspaceContext();

  let { data: route }: { data: PageData } = $props();

  const settings = $derived(getSettings());

  const data = $derived(
    await settings.catch((cause: unknown) => {
      if (settings.error && settings.error.status >= 500 && settings.current)
        return settings.current;
      throw cause;
    }),
  );

  const view = $derived(data.view);

  const readonly = $derived(view.settings.externallyManaged);

  let message = $state("");

  let busy = $state(false);

  const writer = new SettingsWriter(
    () => workspace.organizationId,
    () => {},
  );

  const sections = [
    { id: "identity", label: "Company sign-in" },
    { id: "management", label: "Administration" },
  ];

  beforeNavigate(({ to }) => {
    // Outcomes belong to the section where they happened.
    if (to?.url.origin === page.url.origin && to.url.pathname === "/settings") message = "";
  });

  const useWidefleet = () =>
    writer.save(() =>
      settingsInput.parse({ ...view.settings, sso: null, directory: null, embeddingOrigins: [] }),
    );

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

<svelte:head><title>Settings · Widefleet</title></svelte:head>
<SettingsTabs />
<PageHeading title="Settings" description="Sign-in and workspace administration." />
<nav aria-label="Settings sections" class="mt-7 mb-8 flex gap-6 overflow-x-auto border-b">
  {#each sections as section (section.id)}
    <a
      href={`/settings?section=${section.id}`}
      aria-current={route.section === section.id ? "page" : undefined}
      class={`whitespace-nowrap border-b-2 pb-3 text-xs font-medium ${route.section === section.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
      >{section.label}</a
    >
  {/each}
</nav>
<div class="max-w-2xl space-y-6">
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if writer.error}<Feedback kind="error">{writer.error}</Feedback>{/if}
  {#if view.error}<Feedback kind="error">{view.error}</Feedback>{/if}
  {#if route.section === "management"}
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
  {:else}
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
            href="/settings/sso/setup"
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
  {/if}
</div>
<RestartDialog {writer} />
