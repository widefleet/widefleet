<script lang="ts">
  import { getWorkspaceContext } from "#lib/workspace-context";
  import { onMount, untrack } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { settingsInput, oidcProviderInput } from "@platform/contracts";
  import { z } from "zod";
  import { authClient } from "#lib/auth-client";
  import {
    completeSetup,
    activateCompanySso,
    requestDomainVerification,
    verifyCompanyDomain,
    getSettings,
    planSettings,
    setExternalManagement,
    updateSettings,
  } from "#lib/settings.remote";
  import ReportingSettings from "#shadcn/ReportingSettings.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import { Checkbox } from "#shadcn/components/ui/checkbox/index.js";
  import * as Dialog from "#shadcn/components/ui/dialog/index.js";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
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

  const initialDraft = (
    source: typeof data.view,
  ): Omit<z.infer<typeof settingsInput>, "sso"> & { sso: z.infer<typeof oidcProviderInput> } => ({
    ...$state.snapshot(source.settings),
    directory: source.settings.directory
      ? { ...source.settings.directory, clientSecret: "" }
      : null,
    sso: source.sso
      ? {
          providerId: source.sso.providerId,
          issuer: source.sso.issuer,
          domain: source.sso.domain,
          oidcConfig: { ...$state.snapshot(source.sso.oidcConfig), clientSecret: "" },
        }
      : {
          providerId: `company-${workspace.organizationId}`,
          issuer: "",
          domain: "",
          oidcConfig: {
            clientId: "",
            clientSecret: "",
            pkce: true,
            scopes: ["openid", "profile", "email"],
            mapping: { name: "name", email: "email" },
          },
        },
  });

  let draft = $state(untrack(() => initialDraft(view)));

  let busy = $state(false);

  let savedDraft = $state(untrack(() => JSON.stringify(draft)));

  const dirty = $derived(JSON.stringify(draft) !== savedDraft);

  let message = $state("");

  let saved = $state(false);

  let pending = $state<z.infer<typeof settingsInput> | null>(null);

  let restartOpen = $state(false);

  const readonly = $derived(view.settings.externallyManaged);

  const onboarding = $derived(view.localPasswordEnabled && !data.emailSignIn);

  const callback = $derived(`${data.platformUrl}/api/auth/sso/callback/${draft.sso.providerId}`);

  const sections = $derived([
    { id: "identity", label: "Company sign-in" },
    ...(data.reporting ? [{ id: "reporting", label: "Privacy" }] : []),
    { id: "management", label: "Administration" },
  ]);

  beforeNavigate(({ cancel, to, type }) => {
    if (!dirty || (to?.url.origin === page.url.origin && to.url.pathname === "/settings")) return;

    if (type === "leave" || !window.confirm("You have unsaved changes. Leave this page anyway?"))
      cancel();
  });

  const apply = async (input: z.infer<typeof settingsInput>, acknowledgeRestart: boolean) => {
    await updateSettings({
      ...input,
      acknowledgeRestart,
      organizationId: workspace.organizationId,
    });
    const updated = await getSettings();
    draft = initialDraft(updated.view);
    savedDraft = JSON.stringify(draft);
    proof = null;
    pending = null;
    restartOpen = false;
    saved = true;
  };

  const persist = async (input: z.infer<typeof settingsInput>) => {
    const plan = await planSettings({ ...input, organizationId: workspace.organizationId });

    if (plan.restartRequired) {
      pending = structuredClone(input);
      restartOpen = true;
    } else await apply(input, false);
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    message = "";
    saved = false;

    try {
      await persist(
        settingsInput.parse({
          ...draft,
          externallyManaged: view.settings.externallyManaged,
          directory: draft.directory
            ? { ...draft.directory, clientSecret: draft.directory.clientSecret || undefined }
            : null,
          sso: {
            ...draft.sso,
            oidcConfig: {
              ...draft.sso.oidcConfig,
              clientSecret: draft.sso.oidcConfig.clientSecret || undefined,
            },
          },
        }),
      );
    } catch (cause) {
      message =
        cause instanceof z.ZodError
          ? "Check your provider details and credentials."
          : cause instanceof Error
            ? cause.message
            : "Could not save changes.";
    } finally {
      busy = false;
    }
  };

  const confirm = async () => {
    if (!pending) return;
    busy = true;
    message = "";

    try {
      await apply($state.snapshot(pending), true);
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not save changes.";
      restartOpen = false;
    } finally {
      busy = false;
    }
  };

  const toggleExternal = async () => {
    busy = true;
    message = "";

    try {
      await setExternalManagement({ enabled: !readonly, organizationId: workspace.organizationId });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not apply the change.";
    } finally {
      busy = false;
    }
  };

  const signIn = async () => {
    if (!view.sso) return;
    busy = true;
    message = "";

    try {
      const input = {
        providerId: view.sso.providerId,
        callbackURL: "/settings?account=1",
        errorCallbackURL: "/settings?account=1&error=sso",
      };

      const result = await authClient.signIn.sso(input);

      if (result.error) {
        message = "Could not start company sign-in.";
        busy = false;
      }
    } catch {
      message = "Could not start company sign-in. Check your connection.";
      busy = false;
    }
  };

  let proof = $state<{ name: string; type: "TXT"; value: string } | null>(null);

  const requestProof = async () => {
    busy = true;
    message = "";

    try {
      proof = await requestDomainVerification({ organizationId: workspace.organizationId });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not request domain verification.";
    } finally {
      busy = false;
    }
  };

  const verifyProof = async () => {
    busy = true;
    message = "";

    try {
      await verifyCompanyDomain({ organizationId: workspace.organizationId });
      await getSettings().refresh();
    } catch (cause) {
      message =
        cause instanceof Error ? cause.message : "The DNS TXT record could not be verified.";
    } finally {
      busy = false;
    }
  };

  const activateSso = async () => {
    busy = true;
    message = "";

    try {
      await activateCompanySso({ organizationId: workspace.organizationId });
      busy = false;
      await signIn();
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not activate company SSO.";
    } finally {
      busy = false;
    }
  };

  const complete = async () => {
    busy = true;
    message = "";

    try {
      await completeSetup({ organizationId: workspace.organizationId });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not complete setup.";
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
<PageHeading title="Settings" description="Sign-in, privacy and workspace administration." />
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
  {#if route.loginFailed}<Feedback kind="error"
      >Company sign-in failed. Check your provider, redirect URIs and credentials.</Feedback
    >{/if}
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if view.error}<Feedback kind="error">{view.error}</Feedback>{/if}
  {#if saved}<Feedback kind="success">Settings saved.</Feedback>{/if}
  {#if route.section === "reporting" && data.reporting}
    <ReportingSettings initial={data.reporting} />
  {:else if route.section === "management"}
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
    <form onsubmit={save} class="rounded-xl border p-6">
      <fieldset disabled={readonly || busy} class="space-y-5 disabled:opacity-70">
        <div>
          <h2 class="text-base font-semibold">Company SSO</h2>
          <p class="text-muted-foreground mt-2 text-sm leading-6">
            Create one registration for Widefleet and your apps. Add both redirect URIs and enter
            its credentials once.
          </p>
        </div>
        <div class="space-y-2">
          <Label for="issuer">Issuer URL</Label><Input
            id="issuer"
            type="url"
            bind:value={draft.sso.issuer}
            placeholder="https://login.microsoftonline.com/TENANT-ID/v2.0"
            required
          />
        </div>
        <div class="space-y-2">
          <Label for="company-domain">Company email domain</Label><Input
            id="company-domain"
            bind:value={draft.sso.domain}
            placeholder="example.com"
            required
          />
        </div>
        <div class="space-y-2">
          <p class="text-xs font-medium">Workspace redirect URI</p>
          <CopyValue value={callback} label="Copy workspace redirect URI" />
        </div>
        <div class="space-y-2">
          <p class="text-xs font-medium">App redirect URI</p>
          <CopyValue value={view.appCallbackUrl} label="Copy app redirect URI" />
        </div>
        <div class="space-y-2">
          <Label for="sso-client">Client ID</Label><Input
            id="sso-client"
            bind:value={draft.sso.oidcConfig.clientId}
            required
          />
        </div>
        <div class="space-y-2">
          <Label for="sso-secret">Client secret</Label><Input
            id="sso-secret"
            type="password"
            autocomplete="new-password"
            bind:value={draft.sso.oidcConfig.clientSecret}
            required={!view.sso}
          />
          {#if view.sso}<p class="text-muted-foreground text-xs">
              Leave blank to keep the saved secret.
            </p>{/if}
        </div>
        <div class="space-y-2">
          <Label for="app-identity">App identity claims</Label>
          <NativeSelect
            id="app-identity"
            value={draft.appIdentity.type}
            onchange={(event) => {
              draft.appIdentity =
                event.currentTarget.value === "entra"
                  ? { type: "entra" }
                  : { type: "oidc", groupsClaim: "groups" };
              if (draft.appIdentity.type !== "entra") draft.directory = null;
            }}
            ><option value="oidc">OpenID Connect</option><option value="entra"
              >Microsoft Entra</option
            ></NativeSelect
          >
          <p class="text-muted-foreground text-xs">
            Choose Entra to use Microsoft object IDs and group memberships for app access.
          </p>
        </div>
        <details class="rounded-lg border p-4">
          <summary class="text-sm font-medium">Claim mappings</summary>
          <div class="mt-4 space-y-4">
            <div class="space-y-2">
              <Label for="name-claim">Name</Label><Input
                id="name-claim"
                bind:value={draft.sso.oidcConfig.mapping.name}
                required
              />
            </div>
            <div class="space-y-2">
              <Label for="email-claim">Email</Label><Input
                id="email-claim"
                bind:value={draft.sso.oidcConfig.mapping.email}
                required
              />
            </div>
            {#if draft.appIdentity.type === "oidc"}<div class="space-y-2">
                <Label for="groups-claim">App groups</Label><Input
                  id="groups-claim"
                  bind:value={draft.appIdentity.groupsClaim}
                  required
                />
              </div>{/if}
          </div>
        </details>
        {#if draft.appIdentity.type === "entra"}
          <details class="rounded-lg border p-4">
            <summary class="text-sm font-medium">Directory search</summary>
            <div class="mt-4 space-y-4">
              <div class="flex items-center gap-3">
                <Checkbox
                  id="directory"
                  checked={draft.directory !== null}
                  onCheckedChange={(enabled) => {
                    draft.directory = enabled ? { clientId: "", clientSecret: "" } : null;
                  }}
                /><Label for="directory">Connect Microsoft Graph</Label>
              </div>
              {#if draft.directory}
                <p class="text-muted-foreground text-xs">
                  Directory search needs the GroupMember.Read.All application permission with
                  administrator consent.
                </p>
                <div class="space-y-2">
                  <Label for="directory-client">Directory client ID</Label><Input
                    id="directory-client"
                    bind:value={draft.directory.clientId}
                    required
                  />
                </div>
                <div class="space-y-2">
                  <Label for="directory-secret">Directory client secret</Label>
                  <Input
                    id="directory-secret"
                    type="password"
                    bind:value={draft.directory.clientSecret}
                    required={!view.settings.directory}
                    placeholder={view.settings.directory
                      ? "Leave blank to keep the saved secret"
                      : ""}
                    autocomplete="new-password"
                  />
                </div>
              {/if}
            </div>
          </details>
        {/if}
        <div class="flex items-center justify-between border-t pt-4">
          <span class="text-muted-foreground text-xs">{dirty ? "Unsaved changes" : ""}</span><Button
            id="identity-save"
            type="submit"
            disabled={busy}>{busy ? "Saving …" : "Save"}</Button
          >
        </div>
      </fieldset>
    </form>
    {#if view.sso}
      <section class="space-y-4 rounded-xl border p-6">
        <h2 class="text-base font-semibold">Verify company sign-in</h2>
        {#if dirty}<Feedback>Save your changes before verifying company sign-in.</Feedback>{/if}
        {#if !view.sso.domainVerified}
          <p class="text-muted-foreground text-sm">
            Verify ownership of {view.sso.domain} to enable company sign-in testing. This does not change
            how members currently access the organization.
          </p>
          {#if proof}
            <CopyValue label="DNS record name" value={proof.name} /><CopyValue
              label="TXT value"
              value={proof.value}
            />
            <Button disabled={busy || dirty} onclick={verifyProof}>Verify domain</Button>
          {:else}<Button disabled={busy || dirty} onclick={requestProof}
              >Get verification record</Button
            >{/if}
        {:else}
          {#if !data.tested}
            <Button variant="outline" disabled={busy || dirty} onclick={signIn}
              >Test company sign-in</Button
            >
          {:else}
            <Feedback kind="success"
              >Company sign-in and administrator access verified successfully.</Feedback
            >
          {/if}
          {#if onboarding}
            <p class="text-muted-foreground text-sm">
              Completing setup disables password access and closes local sessions. Server recovery
              remains available.
            </p>
            <Button disabled={busy || dirty || !data.tested} onclick={complete}
              >Complete setup and disable password access</Button
            >
          {:else if !view.ssoRequired}
            <p class="text-muted-foreground text-sm">
              Activating company SSO requires all members to use this provider for this
              organization. Email sign-in will no longer grant access. You can test the connection
              before activating it.
            </p>
            <Button disabled={busy || dirty || readonly} onclick={activateSso}
              >Activate company SSO</Button
            >
          {:else}
            <Feedback kind="success">Company SSO is required for this organization.</Feedback>
          {/if}
        {/if}
        <p class="text-muted-foreground text-xs">{view.activation.message}</p>
      </section>
    {/if}
  {/if}
</div>
<Dialog.Root
  bind:open={restartOpen}
  onOpenChange={(open) => {
    if (!open && !busy) pending = null;
  }}
>
  <Dialog.Content
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      document.getElementById("identity-save")?.focus();
    }}
    class="sm:max-w-md"
    showCloseButton={!busy}
    onInteractOutside={(event) => {
      if (busy) event.preventDefault();
    }}
    onEscapeKeydown={(event) => {
      if (busy) event.preventDefault();
    }}
    ><Dialog.Header
      ><Dialog.Title>Sign-in service restart required</Dialog.Title><Dialog.Description
        >During the restart, requests to published apps may briefly fail, including for signed-in
        users. Apply this configuration now?</Dialog.Description
      ></Dialog.Header
    ><Dialog.Footer
      ><Button
        variant="outline"
        disabled={busy}
        onclick={() => {
          pending = null;
          restartOpen = false;
        }}>Cancel</Button
      ><Button disabled={busy} onclick={confirm}>{busy ? "Applying …" : "Save and restart"}</Button
      ></Dialog.Footer
    ></Dialog.Content
  >
</Dialog.Root>
