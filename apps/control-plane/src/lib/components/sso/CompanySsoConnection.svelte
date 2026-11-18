<script lang="ts">
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { settingsInput, type settingsView } from "@platform/contracts";
  import type { z } from "zod";
  import { warnBeforeLeaving } from "#lib/unsaved-changes";
  import {
    nextSetupStep,
    ssoReady,
    domainRequired,
    SettingsWriter,
    ssoDraft,
    ssoInput,
    ssoProviders,
    startCompanySignIn,
  } from "#lib/sso-setup.svelte";
  import { Button } from "@platform/ui/button";
  import CopyValue from "../CopyValue.svelte";
  import Feedback from "../Feedback.svelte";
  import StatusBadge from "../StatusBadge.svelte";
  import CompanyDomains from "../CompanyDomains.svelte";
  import RestartDialog from "./RestartDialog.svelte";
  import SsoConnectionFields from "./SsoConnectionFields.svelte";

  let {
    view,
    organizationId,
    platformUrl,
    linked,
    tested,
    emailSignIn,
    loginFailed,
  }: {
    view: z.infer<typeof settingsView>;
    organizationId: string;
    platformUrl: string;
    linked: boolean;
    tested: boolean;
    emailSignIn: boolean;
    loginFailed: boolean;
  } = $props();

  const readonly = $derived(view.settings.externallyManaged);

  // Editing is part of the URL, so the form survives a reload and can be linked to.
  const editing = $derived(!readonly && page.url.searchParams.has("edit"));

  let saved = $state(false);

  let draft = $state(untrack(() => ssoDraft(view, organizationId)));

  let baseline = $state(untrack(() => JSON.stringify(draft)));

  warnBeforeLeaving(() => editing && JSON.stringify(draft) !== baseline);

  const edits = new SettingsWriter(
    () => organizationId,
    async () => {
      baseline = JSON.stringify(draft);
      await goto("/settings", { reset: false });
      saved = true;
    },
  );

  const removal = new SettingsWriter(
    () => organizationId,
    () => {},
  );

  let testError = $state("");

  let testing = $state(false);

  const provider = $derived(view.sso ? ssoProviders[view.sso.appIdentityType] : null);

  const callback = $derived(
    view.sso ? `${platformUrl}/api/auth/sso/callback/${view.sso.providerId}` : "",
  );

  const startEditing = () => {
    draft = ssoDraft(view, organizationId);
    baseline = JSON.stringify(draft);
    saved = false;
    void goto("/settings?edit", { reset: false });
  };

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    void edits.save(() => ssoInput(draft, view));
  };

  const test = async () => {
    if (!view.sso) return;
    testing = true;
    testError = (await startCompanySignIn(view.sso.providerId, "/settings")) ?? "";
    testing = false;
  };

  const remove = () =>
    removal.save(() => settingsInput.parse({ ...view.settings, sso: null, directory: null }));
</script>

{#if view.sso}
  <div class="space-y-6">
    <div>
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-base font-semibold">Company SSO</h2>
        <StatusBadge
          tone={view.ssoRequired ? "success" : "pending"}
          label={view.ssoRequired ? "Active" : "Setup in progress"}
        />
      </div>
      <p class="text-muted-foreground mt-1 text-sm">
        {provider?.label}{view.ssoRequired ? " · Required for all members" : ""}
      </p>
    </div>
    {#if readonly}<Feedback
        >Settings are managed through the API or CLI. Enable browser editing under Administration to
        change them here.</Feedback
      >{/if}
    {#if saved}<Feedback kind="success">Settings saved.</Feedback>{/if}
    {#if !view.ssoRequired}
      <section class="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-6">
        <div>
          <h3 class="text-base font-semibold">Finish setup</h3>
          <p class="text-muted-foreground mt-1 text-sm">
            Members keep their current sign-in until you activate company SSO.
          </p>
        </div>
        <Button href={`/settings/sso/setup?step=${nextSetupStep(view, linked)}`}
          >Continue setup</Button
        >
      </section>
    {/if}

    <section class="rounded-xl border p-6" aria-labelledby="connection-title">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 id="connection-title" class="text-base font-semibold">Connection</h3>
          <p class="text-muted-foreground mt-1 text-sm">
            One registration serves Widefleet and your apps.
          </p>
        </div>
        {#if !editing}<Button variant="outline" size="sm" disabled={readonly} onclick={startEditing}
            >Edit configuration</Button
          >{/if}
      </div>
      {#if editing}
        <form onsubmit={save} class="mt-6 space-y-5">
          <fieldset disabled={edits.busy} class="disabled:opacity-70">
            <SsoConnectionFields bind:draft {view} creating={false} />
          </fieldset>
          {#if edits.error}<Feedback kind="error">{edits.error}</Feedback>{/if}
          <div class="flex justify-end gap-2 border-t pt-5">
            <Button
              variant="outline"
              disabled={edits.busy}
              onclick={() => goto("/settings", { reset: false })}>Cancel</Button
            >
            <Button id="identity-save" type="submit" disabled={edits.busy}
              >{edits.busy ? "Saving …" : "Save"}</Button
            >
          </div>
        </form>
      {:else}
        <dl class="mt-6 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt class="text-muted-foreground">Provider</dt>
          <dd>{provider?.label}</dd>
          {#if view.sso.appIdentityType !== "google"}
            <dt class="text-muted-foreground">Issuer URL</dt>
            <dd class="wrap-anywhere">{view.sso.issuer}</dd>
          {/if}
          <dt class="text-muted-foreground">Client ID</dt>
          <dd class="font-mono text-xs leading-5 wrap-anywhere">{view.sso.oidcConfig.clientId}</dd>
        </dl>
        <div class="mt-6 space-y-4">
          <div class="space-y-2">
            <p class="text-xs font-medium">Workspace redirect URI</p>
            <CopyValue value={callback} label="Copy workspace redirect URI" />
          </div>
          <div class="space-y-2">
            <p class="text-xs font-medium">App redirect URI</p>
            <CopyValue value={view.appCallbackUrl} label="Copy app redirect URI" />
          </div>
        </div>
      {/if}
      <p class="text-muted-foreground mt-6 text-xs">{view.activation.message}</p>
    </section>

    <CompanyDomains
      domains={view.ssoDomains}
      {organizationId}
      {readonly}
      verificationRequired={view.ssoPolicy.domainVerificationRequired}
      domainRequired={domainRequired(view, view.sso.appIdentityType)}
    />

    <section class="space-y-4 rounded-xl border p-6" aria-labelledby="test-title">
      <div>
        <h3 id="test-title" class="text-base font-semibold">Test sign-in</h3>
        <p class="text-muted-foreground mt-1 text-sm">
          Sign in with your company account to check the connection and your administrator access.
        </p>
      </div>
      {#if loginFailed}<Feedback kind="error"
          >Company sign-in failed. Check your provider, redirect URIs and credentials.</Feedback
        >{/if}
      {#if testError}<Feedback kind="error">{testError}</Feedback>{/if}
      {#if !view.ssoPolicy.domainVerificationRequired && !view.ssoPolicy.allowEmailAccountLinking && !linked}
        <p class="text-muted-foreground text-sm">
          Matching email addresses do not automatically link existing accounts. The installation
          operator can enable this when moving existing users to SSO.
        </p>
      {/if}
      {#if tested}<Feedback kind="success"
          >Company sign-in and administrator access verified successfully.</Feedback
        >{/if}
      <Button variant="outline" disabled={testing || editing || !ssoReady(view)} onclick={test}
        >Test company sign-in</Button
      >
    </section>

    {#if emailSignIn}
      <section class="rounded-xl border border-destructive/25 p-6" aria-labelledby="remove-title">
        <h3
          id="remove-title"
          class="text-destructive flex items-center gap-2 text-sm font-semibold"
        >
          <Trash2 class="size-4" />Remove company SSO
        </h3>
        <p class="text-muted-foreground mt-2 text-sm leading-6">
          Members sign in with Widefleet again, and apps use Widefleet sign-in. The email domains of
          this connection are removed.
        </p>
        {#if removal.error}<div class="mt-4">
            <Feedback kind="error">{removal.error}</Feedback>
          </div>{/if}
        <details class="mt-5">
          <summary class="text-sm font-medium">Remove this connection</summary>
          <div class="mt-4">
            <Button variant="destructive" disabled={readonly || removal.busy} onclick={remove}
              ><Trash2 />{removal.busy ? "Removing …" : "Remove company SSO"}</Button
            >
          </div>
        </details>
      </section>
    {/if}
  </div>
{/if}
<RestartDialog writer={edits} />
<RestartDialog writer={removal} />
