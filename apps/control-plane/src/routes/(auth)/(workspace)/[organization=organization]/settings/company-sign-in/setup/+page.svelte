<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { warnBeforeLeaving } from "#lib/unsaved-changes";
  import { activateCompanySso, getSettings, verifyCompanyDomain } from "#lib/settings.remote";
  import {
    failureMessage,
    nextSetupStep,
    ssoReady,
    domainRequired,
    providerConsoles,
    SettingsWriter,
    setupStep,
    setupSteps,
    ssoDraft,
    ssoInput,
    ssoProviders,
    startCompanySignIn,
  } from "#lib/sso-setup.svelte";
  import { oidcProviderInput } from "@platform/contracts";
  import { Button } from "@platform/ui/button";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import ConsoleLink from "#shadcn/components/sso/ConsoleLink.svelte";
  import DnsRecord from "#shadcn/components/DnsRecord.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import RestartDialog from "#shadcn/components/sso/RestartDialog.svelte";
  import SsoConnectionFields from "#shadcn/components/sso/SsoConnectionFields.svelte";
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

  // Before the connection is saved, the chosen provider lives in the URL so a reload or
  // shared link keeps it.
  const chosen = $derived(
    oidcProviderInput.shape.appIdentityType.safeParse(page.url.searchParams.get("provider")).data,
  );

  const withProvider = (
    draft: ReturnType<typeof ssoDraft>,
    id: keyof typeof ssoProviders,
  ): ReturnType<typeof ssoDraft> => ({
    ...draft,
    directory: id === "entra" ? draft.directory : null,
    sso: {
      ...draft.sso,
      appIdentityType: id,
      // Google uses a fixed issuer; other providers need their own.
      issuer:
        id === "google"
          ? "https://accounts.google.com"
          : draft.sso.appIdentityType === "google"
            ? ""
            : draft.sso.issuer,
    },
  });

  let draft = $state(
    untrack(() => {
      const initial = ssoDraft(view, workspace.organizationId);

      return !view.sso && chosen ? withProvider(initial, chosen) : initial;
    }),
  );

  // Credentials entered before the connection is saved exist only in this page.
  warnBeforeLeaving(() => {
    if (view.sso) return false;
    const blank = ssoDraft(view, workspace.organizationId);

    return JSON.stringify(draft) !== JSON.stringify(chosen ? withProvider(blank, chosen) : blank);
  });

  $effect(() => {
    if (!view.sso && chosen && untrack(() => draft.sso.appIdentityType) !== chosen)
      draft = withProvider(
        untrack(() => draft),
        chosen,
      );
  });

  const indexOf = (id: string) => setupSteps.findIndex((entry) => entry.id === id);

  const next = $derived(nextSetupStep(view, data.linked));

  // Before the connection is saved only its first three steps apply; afterwards they are
  // done, and later steps open once the earlier ones are complete.
  const step = $derived.by(() => {
    const requested = setupStep.safeParse(page.url.searchParams.get("step")).data ?? next;

    if (!view.sso)
      return chosen && indexOf(requested) <= indexOf("credentials") ? requested : "provider";

    const index = indexOf(requested);

    return index >= indexOf("domain") && index <= indexOf(next) ? requested : next;
  });

  const reachable = (id: string) =>
    view.sso
      ? indexOf(id) >= indexOf("domain") && indexOf(id) <= indexOf(next)
      : indexOf(id) <= indexOf(step);

  const done = (id: string) =>
    view.sso
      ? indexOf(id) < indexOf("domain") ||
        (id === "domain" && ssoReady(view)) ||
        (id === "test" && data.linked)
      : indexOf(id) < indexOf(step);

  const provider = $derived(ssoProviders[draft.sso.appIdentityType]);

  const callback = $derived(`${data.platformUrl}/api/auth/sso/callback/${draft.sso.providerId}`);

  const stepHref = (id: string) =>
    !view.sso && chosen
      ? workspace.path(`/settings/company-sign-in/setup?provider=${chosen}&step=${id}`)
      : workspace.path(`/settings/company-sign-in/setup?step=${id}`);

  const go = (id: string) => goto(stepHref(id));

  const writer = new SettingsWriter(
    () => workspace.organizationId,
    () => go("domain"),
  );

  let busy = $state(false);

  let error = $state("");

  const run = async (action: () => Promise<void>, fallback: string) => {
    busy = true;
    error = "";

    try {
      await action();
    } catch (cause) {
      error = failureMessage(cause, fallback);
    } finally {
      busy = false;
    }
  };

  const chooseProvider = (id: keyof typeof ssoProviders) =>
    goto(workspace.path(`/settings/company-sign-in/setup?provider=${id}&step=register`));

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    void writer.save(() => ssoInput(draft, view));
  };

  const pendingDomains = $derived(view.ssoDomains.filter((entry) => entry.record));

  const verifiedDomains = $derived(view.ssoDomains.filter((entry) => entry.verified));

  const verify = (domain: string) =>
    run(
      () => verifyCompanyDomain({ organizationId: workspace.organizationId, domain }),
      "The DNS record could not be verified.",
    );

  const test = () =>
    run(async () => {
      if (!view.sso) return;

      const failure = await startCompanySignIn(
        view.sso.providerId,
        workspace.path("/settings/company-sign-in/setup?step=test"),
      );

      if (failure) error = failure;
    }, "Could not start company sign-in.");

  const activate = () =>
    run(async () => {
      if (!view.sso) return;
      await activateCompanySso({ organizationId: workspace.organizationId });

      // Activation replaces this browser's email session with a company one.
      const failure = await startCompanySignIn(
        view.sso.providerId,
        workspace.path("/settings/company-sign-in"),
      );

      if (failure) error = failure;
    }, "Could not activate company SSO.");

  const current = $derived(setupSteps[indexOf(step)]);
</script>

<svelte:head><title>Set up company SSO · Widefleet</title></svelte:head>
<a
  href={workspace.path("/settings/company-sign-in")}
  class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
  ><ChevronLeft class="size-3.5" />Settings</a
>
<div class="mt-3 flex flex-wrap items-start justify-between gap-4">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Set up company SSO</h1>
    <p class="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
      Members sign in with your company's identity provider, and apps use the same login.
    </p>
  </div>
  <!-- A saved connection's credentials, domains and removal stay reachable during setup. -->
  {#if view.sso}<Button
      variant="outline"
      size="sm"
      href={workspace.path("/settings/company-sign-in")}>Manage connection</Button
    >{/if}
</div>

<div class="mt-8 grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
  <nav aria-label="Setup steps" class="hidden md:block">
    <ol class="space-y-1">
      {#each setupSteps as entry, index (entry.id)}
        {@const state = entry.id === step ? "current" : done(entry.id) ? "done" : "upcoming"}
        <li>
          <svelte:element
            this={reachable(entry.id) && entry.id !== step ? "a" : "span"}
            href={reachable(entry.id) && entry.id !== step ? stepHref(entry.id) : undefined}
            aria-current={state === "current" ? "step" : undefined}
            class={`flex items-center gap-3 rounded-md px-2 py-1.5 text-sm ${state === "current" ? "bg-muted font-medium" : state === "done" ? "text-foreground hover:bg-muted/60" : "text-muted-foreground"}`}
          >
            <span
              class={`grid size-5 shrink-0 place-items-center rounded-full text-[11px] ${state === "done" ? "bg-emerald-500 text-white" : state === "current" ? "bg-foreground text-background" : "border"}`}
              >{#if state === "done"}<Check class="size-3" />{:else}{index + 1}{/if}</span
            >{entry.label}
          </svelte:element>
        </li>
      {/each}
    </ol>
  </nav>

  <div class="min-w-0 max-w-2xl">
    <p class="text-muted-foreground text-xs md:hidden">
      Step {indexOf(step) + 1} of {setupSteps.length}
    </p>
    <h2 class="text-lg font-semibold">{current?.label}</h2>
    <div class="mt-5 space-y-5">
      {#if readonly}<Feedback
          >Settings are managed through the API or CLI. Enable browser editing under Administration
          to change them here.</Feedback
        >{/if}
      {#if error}<Feedback kind="error">{error}</Feedback>{/if}

      {#if step === "provider"}
        <p class="text-muted-foreground text-sm leading-6">
          Choose the identity provider your company uses to sign in.
        </p>
        <ul class="space-y-3" aria-label="Identity providers">
          {#each Object.entries(ssoProviders) as [id, entry] (id)}
            <li>
              <button
                type="button"
                disabled={readonly}
                onclick={() => chooseProvider(id as keyof typeof ssoProviders)}
                class={`hover:bg-muted/50 w-full rounded-xl border p-4 text-left transition-colors disabled:opacity-60 ${chosen === id ? "border-foreground/40" : ""}`}
              >
                <span class="block text-sm font-medium">{entry.label}</span>
                <span class="text-muted-foreground mt-1 block text-sm leading-6"
                  >{entry.description}</span
                >
              </button>
            </li>
          {/each}
        </ul>
      {:else if step === "register"}
        <p class="text-muted-foreground text-sm leading-6">
          Create one registration in {provider.label} for Widefleet and your apps.
        </p>
        <ol class="list-decimal space-y-2 pl-5 text-sm leading-6">
          {#if draft.sso.appIdentityType === "entra"}
            <li>
              Open <ConsoleLink href={providerConsoles.entraAppRegistrations}
                >App registrations</ConsoleLink
              > in the Microsoft Entra admin center (Entra ID → App registrations) and choose New registration.
            </li>
            <li>Add both redirect URIs below as Web redirect URIs.</li>
            <li>
              Under Certificates &amp; secrets, create a client secret. Note the application
              (client) ID and directory (tenant) ID from the registration's overview.
            </li>
          {:else if draft.sso.appIdentityType === "google"}
            <li>
              Open the <ConsoleLink href={providerConsoles.googleAuthPlatform}
                >Google Auth Platform</ConsoleLink
              > in your Google Cloud project and set its audience to Internal.
            </li>
            <li>
              Under <ConsoleLink href={providerConsoles.googleClients}>Clients</ConsoleLink>, create
              an OAuth client of type Web application.
            </li>
            <li>Add both redirect URIs below as authorized redirect URIs.</li>
          {:else}
            <li>Create a confidential web application that uses the authorization code flow.</li>
            <li>Add both redirect URIs below.</li>
            <li>Note the client ID, client secret and issuer URL.</li>
          {/if}
        </ol>
        <div class="space-y-2">
          <p class="text-xs font-medium">Workspace redirect URI</p>
          <CopyValue value={callback} label="Copy workspace redirect URI" />
        </div>
        <div class="space-y-2">
          <p class="text-xs font-medium">App redirect URI</p>
          <CopyValue value={view.appCallbackUrl} label="Copy app redirect URI" />
        </div>
        <p class="text-sm">
          <a href={provider.guide} target="_blank" rel="noreferrer" class="text-primary"
            >Step-by-step guide for {provider.label}</a
          >
        </p>
        <div class="flex justify-between border-t pt-5">
          <Button variant="outline" href={stepHref("provider")}>Back</Button>
          <Button onclick={() => go("credentials")}>Continue</Button>
        </div>
      {:else if step === "credentials"}
        <form onsubmit={save} class="space-y-5">
          <fieldset disabled={readonly || writer.busy} class="disabled:opacity-70">
            <SsoConnectionFields
              bind:draft
              {view}
              creating
              domainOptional={!domainRequired(view, draft.sso.appIdentityType)}
            />
          </fieldset>
          {#if writer.error}<Feedback kind="error">{writer.error}</Feedback>{/if}
          <div class="flex justify-between border-t pt-5">
            <Button variant="outline" href={stepHref("register")}>Back</Button>
            <Button type="submit" disabled={readonly || writer.busy}
              >{writer.busy ? "Saving …" : "Save and continue"}</Button
            >
          </div>
        </form>
      {:else if step === "domain"}
        {#if !view.ssoPolicy.domainVerificationRequired}
          <Feedback kind="success"
            >This installation trusts its configured identity provider. DNS verification is not
            required.</Feedback
          >
          <div class="flex justify-end border-t pt-5">
            <Button onclick={() => go("test")}>Continue</Button>
          </div>
        {:else if verifiedDomains.length}
          <Feedback kind="success"
            >{verifiedDomains.map((entry) => entry.domain).join(", ")}
            {verifiedDomains.length === 1 ? "is" : "are"} verified.</Feedback
          >
          <div class="flex justify-end border-t pt-5">
            <Button onclick={() => go("test")}>Continue</Button>
          </div>
        {:else if pendingDomains.length}
          <p class="text-muted-foreground text-sm leading-6">
            Prove that your company owns its email domain. Add this TXT record at your DNS provider,
            then verify. New records can take a few minutes to appear.
          </p>
          {#each pendingDomains as entry (entry.domain)}
            {#if entry.record}
              <div class="space-y-3">
                {#if pendingDomains.length > 1}<p class="text-sm font-medium">
                    {entry.domain}
                  </p>{/if}
                <DnsRecord name={entry.record.name} value={entry.record.value} />
                <Button disabled={busy} onclick={() => verify(entry.domain)}
                  >{busy ? "Verifying …" : `Verify ${entry.domain}`}</Button
                >
              </div>
            {/if}
          {/each}
        {:else}
          <p class="text-muted-foreground text-sm leading-6">
            Add the email domain of your members, then verify it with a DNS record.
          </p>
          <Button href={workspace.path("/settings/company-sign-in?add")}>Add email domain</Button>
        {/if}
      {:else if step === "test"}
        <p class="text-muted-foreground text-sm leading-6">
          Sign in with your company account. Widefleet confirms that the connection works and that
          your account keeps administrator access. Members are not affected.
        </p>
        {#if route.loginFailed}
          <Feedback kind="error"
            >Company sign-in failed. Check your provider, redirect URIs and credentials.</Feedback
          >
          <Button variant="outline" href={workspace.path("/settings/company-sign-in?edit")}
            >Edit configuration</Button
          >
        {/if}
        {#if data.tested}
          <Feedback kind="success"
            >Company sign-in and administrator access verified successfully.</Feedback
          >
          <div class="flex justify-end border-t pt-5">
            <Button onclick={() => go("activate")}>Continue</Button>
          </div>
        {:else}
          {#if data.linked}
            <p class="text-muted-foreground text-sm leading-6">
              Your account is already linked to this provider. Test again after changing the
              connection, or continue.
            </p>
          {:else if !view.ssoPolicy.domainVerificationRequired && view.ssoPolicy.allowEmailAccountLinking}
            <p class="text-muted-foreground text-sm leading-6">
              The installation operator allows matching email addresses to link existing accounts.
            </p>
          {:else if !view.ssoPolicy.domainVerificationRequired}
            <Feedback
              >Matching email addresses do not automatically link existing accounts. Ask the
              installation operator to allow email account linking, so your account can be linked
              before you activate company SSO.</Feedback
            >
          {/if}
          <div class="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onclick={test}>Test company sign-in</Button>
            {#if data.linked}<Button variant="ghost" onclick={() => go("activate")}>Continue</Button
              >{/if}
          </div>
        {/if}
      {:else if step === "activate"}
        <p class="text-muted-foreground text-sm leading-6">
          Activating company SSO requires all members to use this provider for this organization.
          Email sign-in will no longer grant access, and apps sign in with your company provider.
        </p>
        <Button disabled={busy || readonly} onclick={activate}>Activate company SSO</Button>
      {/if}
    </div>
  </div>
</div>
<RestartDialog {writer} />
