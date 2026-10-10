<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { identitySettingsInput, settingsInput } from "@platform/contracts";
  import { z } from "zod";
  import { authClient } from "#lib/auth-client";
  import {
    completeSetup,
    getSettings,
    planSettings,
    setExternalManagement,
    updateSettings,
  } from "#lib/settings.remote";
  import ReportingSettings from "#shadcn/ReportingSettings.svelte";
  import SecretField from "#shadcn/SecretField.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import { Checkbox } from "#shadcn/components/ui/checkbox/index.js";
  import * as Dialog from "#shadcn/components/ui/dialog/index.js";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import Check from "@lucide/svelte/icons/check";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const settings = $derived(getSettings());

  // Activation polling must preserve the configuration during a transient connection failure.
  const data = $derived(
    await settings.catch((cause: unknown) => {
      if (settings.error && settings.error.status >= 500 && settings.current)
        return settings.current;
      throw cause;
    }),
  );

  const view = $derived(data.view);

  // Empty fields are a draft; schema validation runs when the complete configuration is submitted.
  const initialDraft = (): z.infer<typeof identitySettingsInput> =>
    data.view.settings.identity
      ? $state.snapshot(data.view.settings.identity)
      : {
          provider: {
            type: "entra",
            tenantId: "",
            authority: "https://login.microsoftonline.com",
            label: "Microsoft Entra",
          },
          management: { clientId: "", secret: { type: "value", value: "" } },
          apps: { clientId: "", secret: { type: "value", value: "" } },
          directory: null,
        };

  let identity = $state(untrack(initialDraft));

  let step = $state(
    untrack(() =>
      page.url.searchParams.has("account") ||
      (data.view.localPasswordEnabled && data.view.settings.identity)
        ? 4
        : 1,
    ),
  );

  let stepHeading = $state<HTMLHeadingElement | null>(null);

  let busy = $state(false);

  let savedIdentity = $state(untrack(() => JSON.stringify(identity)));

  const dirty = $derived(JSON.stringify(identity) !== savedIdentity);

  let message = $state("");

  let saved = $state(false);

  const refreshFailed = $derived(Boolean(settings.error));

  let pending = $state<z.infer<typeof settingsInput> | null>(null);

  let restartOpen = $state(false);

  const readonly = $derived(view.settings.externallyManaged);

  const onboarding = $derived(view.localPasswordEnabled);

  const steps = ["Provider", "Administration", "App sign-in", "Verify & finish"];

  const sections = [
    { id: "identity", label: "Company sign-in" },
    { id: "reporting", label: "Privacy" },
    { id: "management", label: "Administration" },
  ];

  beforeNavigate(({ cancel, to, type }) => {
    if (!dirty || (to?.url.origin === page.url.origin && to.url.pathname === "/settings")) return;

    if (type === "leave" || !window.confirm("You have unsaved changes. Leave this page anyway?"))
      cancel();
  });

  const openStep = async (next: number) => {
    step = next;
    message = "";
    await tick();
    stepHeading?.focus();
  };

  const providerChange = (event: Event) => {
    const target = event.currentTarget;

    if (!(target instanceof HTMLSelectElement)) return;
    identity.provider =
      target.value === "entra"
        ? {
            type: "entra",
            tenantId: "",
            authority: "https://login.microsoftonline.com",
            label: "Microsoft Entra",
          }
        : {
            type: "oidc",
            issuer: "",
            label: "",
            groupsClaim: "groups",
            subjectClaim: "sub",
            nameClaim: "name",
            emailClaim: "email",
          };
    identity.directory = null;
  };

  const apply = async (input: z.infer<typeof settingsInput>, acknowledgeRestart: boolean) => {
    await updateSettings({ ...input, acknowledgeRestart });
    const updated = await getSettings();

    if (updated.view.settings.identity) identity = $state.snapshot(updated.view.settings.identity);
    savedIdentity = JSON.stringify(identity);
    pending = null;
    restartOpen = false;
    saved = true;

    if (onboarding) await openStep(4);
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    message = "";
    saved = false;

    try {
      const input = settingsInput.parse({
        identity,
        externallyManaged: view.settings.externallyManaged,
      });

      const plan = await planSettings(input);

      if (plan.restartRequired) {
        pending = structuredClone(input);
        restartOpen = true;
      } else await apply(input, false);
    } catch (cause) {
      message =
        cause instanceof z.ZodError
          ? "Check your provider details and credentials. Use the steps above to go back."
          : cause instanceof Error
            ? cause.message
            : "Could not save changes.";
    } finally {
      busy = false;
    }
  };

  const submitStep = async (event: SubmitEvent) => {
    if (onboarding && step < 3) {
      event.preventDefault();
      await openStep(step + 1);
    } else await save(event);
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
      await setExternalManagement({ enabled: !readonly });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not apply the change.";
    } finally {
      busy = false;
    }
  };

  const signIn = async (link: boolean) => {
    if (!data.provider) return;
    busy = true;
    message = "";

    try {
      const input = {
        provider: data.provider,
        callbackURL: "/settings?account=1",
        errorCallbackURL: "/settings?account=1&error=sso",
      };

      const result = link
        ? await authClient.linkSocial(input)
        : await authClient.signIn.social(input);

      if (result.error) {
        message = "Could not start company sign-in.";
        busy = false;
      }
    } catch {
      message = "Could not start company sign-in. Check your connection.";
      busy = false;
    }
  };

  const complete = async () => {
    busy = true;
    message = "";

    try {
      await completeSetup();
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

  const managementCallback = async (
    provider: z.infer<typeof identitySettingsInput>["provider"],
  ) => {
    if (provider.type === "entra") return `${data.platformUrl}/api/auth/callback/microsoft`;

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(provider.issuer.replace(/\/$/, "")),
    );

    const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24);

    return `${data.platformUrl}/api/auth/callback/oidc-${id}`;
  };

  const callback = $derived(managementCallback(identity.provider));
</script>

<svelte:head><title>Settings · Widefleet</title></svelte:head>
<PageHeading
  title={onboarding ? "Your workspace starts here." : "Settings"}
  description={onboarding
    ? "Set up company sign-in. We'll guide you from connecting your provider to verifying administrator access."
    : "Sign-in, privacy and workspace administration."}
/>
<nav aria-label="Settings sections" class="mt-7 mb-8 flex gap-6 overflow-x-auto border-b">
  {#each sections as section (section.id)}<a
      href={`/settings?section=${section.id}`}
      aria-current={route.section === section.id ? "page" : undefined}
      class={`whitespace-nowrap border-b-2 pb-3 text-xs font-medium ${route.section === section.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
      >{section.label}</a
    >{/each}
</nav>
<div class="space-y-5">
  {#if route.loginFailed}<Feedback kind="error"
      >Company sign-in failed. Check your provider, redirect URI and credentials, then try again.</Feedback
    >{/if}
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if view.error}<Feedback kind="error">{view.error}</Feedback>{/if}
  {#if saved}<Feedback kind="success">Settings saved.</Feedback>{/if}
  {#if route.section === "reporting"}<ReportingSettings initial={data.reporting} />
  {:else if route.section === "management"}
    <section class="max-w-2xl rounded-xl border p-6">
      <h2 class="text-base font-semibold">Manage configuration</h2>
      <p class="text-muted-foreground mt-2 mb-5 text-sm leading-6">
        {readonly
          ? "Settings are managed through the API or CLI. You can view them here. Enable browser editing to make changes here."
          : "Settings can be changed here, through the API or through the CLI. If you manage configuration automatically, you can disable browser editing."}
      </p>
      <Button variant="outline" disabled={busy} onclick={toggleExternal}
        >{readonly ? "Enable browser editing" : "Manage settings externally"}</Button
      >
    </section>
  {:else}
    {#if readonly}<Feedback
        >This configuration is managed externally. <a
          class="underline underline-offset-4"
          href="/settings?section=management">Manage editing</a
        ></Feedback
      >{/if}
    <div class="grid items-start gap-7 lg:grid-cols-[190px_minmax(0,1fr)]">
      <nav
        aria-label={onboarding ? "Setup steps" : "Sign-in settings"}
        class="flex gap-2 overflow-x-auto lg:flex-col lg:gap-1"
      >
        {#each steps as label, index (label)}
          <Button
            variant="ghost"
            disabled={busy || (onboarding && !view.settings.identity && index + 1 > step)}
            onclick={() => openStep(index + 1)}
            aria-current={step === index + 1 ? "step" : undefined}
            class={`h-auto justify-start gap-2.5 px-3 py-3 text-xs ${step === index + 1 ? "bg-muted font-medium" : "text-muted-foreground"}`}
            ><span
              class={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] ${step === index + 1 ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
              >{#if onboarding && index + 1 < step}<Check class="size-3" />{:else}{index +
                  1}{/if}</span
            >{index === 3 && !onboarding ? "Company account" : label}</Button
          >
        {/each}
      </nav>
      <div class="min-w-0 max-w-2xl space-y-5">
        {#if view.settings.identity}
          <div class="bg-muted/40 space-y-2 rounded-lg p-4">
            <h3 class="text-xs font-medium">App sign-in status</h3>
            <p class="text-muted-foreground text-xs leading-6" role="status">
              {view.activation.state === "active"
                ? "The sign-in service is running with the saved configuration."
                : view.activation.state === "failed"
                  ? view.activation.message
                  : view.activation.state === "applying"
                    ? "Activating configuration …"
                    : "The sign-in service is waiting for configuration."}
            </p>
            <p class="text-muted-foreground text-[11px] leading-5">
              A running service does not yet confirm successful sign-in with your provider.
            </p>
          </div>
          {#if refreshFailed}<Feedback kind="error"
              >Could not refresh the activation status. Check your connection and reload the page.</Feedback
            >{/if}
        {/if}
        {#if step <= 3}
          <form
            onsubmit={submitStep}
            oninput={() => {
              pending = null;
              saved = false;
            }}
            class="rounded-xl border p-5 sm:p-7"
          >
            <fieldset disabled={readonly || busy} class="space-y-6">
              {#if step === 1}
                <div>
                  <h2
                    bind:this={stepHeading}
                    tabindex="-1"
                    class="text-base font-semibold outline-none"
                  >
                    Connect your identity provider
                  </h2>
                  <p class="text-muted-foreground mt-2 text-sm leading-6">
                    Choose how your team signs in. You'll need access to your provider's
                    administration area.
                  </p>
                </div>
                <div class="space-y-2">
                  <Label for="identity-provider">Provider</Label><NativeSelect
                    id="identity-provider"
                    value={identity.provider.type}
                    onchange={providerChange}
                    class="w-full"
                    ><option value="entra">Microsoft Entra</option><option value="oidc"
                      >OpenID Connect</option
                    ></NativeSelect
                  >
                </div>
                {#if identity.provider.type === "entra"}
                  <div class="space-y-2">
                    <Label for="tenant">Directory ID (tenant ID)</Label><Input
                      id="tenant"
                      bind:value={identity.provider.tenantId}
                      required
                      class="h-10"
                      placeholder="00000000-0000-0000-0000-000000000000"
                    />
                  </div>
                  <details class="rounded-lg border p-4">
                    <summary class="text-muted-foreground text-xs font-medium"
                      >Advanced provider settings</summary
                    >
                    <div class="mt-4 space-y-2">
                      <Label for="authority">Authority</Label><Input
                        id="authority"
                        type="url"
                        bind:value={identity.provider.authority}
                        required
                      />
                      <p class="text-muted-foreground text-xs leading-5">
                        The default address works with the public Microsoft cloud.
                      </p>
                    </div>
                  </details>
                {:else}
                  <div class="space-y-2">
                    <Label for="provider-label">Display name</Label><Input
                      id="provider-label"
                      bind:value={identity.provider.label}
                      placeholder="Company sign-in"
                      required
                    />
                  </div>
                  <div class="space-y-2">
                    <Label for="issuer">Issuer URL</Label><Input
                      id="issuer"
                      type="url"
                      bind:value={identity.provider.issuer}
                      required
                      placeholder="https://login.example.com"
                    />
                  </div>
                  <details class="rounded-lg border p-4">
                    <summary class="text-muted-foreground text-xs font-medium">Token claims</summary
                    >
                    <div class="mt-4 space-y-4">
                      <div class="space-y-2">
                        <Label for="subject-claim">Stable person ID</Label><Input
                          id="subject-claim"
                          bind:value={identity.provider.subjectClaim}
                          required
                        />
                        <p class="text-muted-foreground text-xs leading-5">
                          Use an immutable ID that identifies the same person in management and app
                          sign-in.
                        </p>
                      </div>
                      <div class="space-y-2">
                        <Label for="groups-claim">Groups</Label><Input
                          id="groups-claim"
                          bind:value={identity.provider.groupsClaim}
                          required
                        />
                      </div>
                      <div class="space-y-2">
                        <Label for="name-claim">Name</Label><Input
                          id="name-claim"
                          bind:value={identity.provider.nameClaim}
                          required
                        />
                      </div>
                      <div class="space-y-2">
                        <Label for="email-claim">Email</Label><Input
                          id="email-claim"
                          bind:value={identity.provider.emailClaim}
                          required
                        />
                      </div>
                    </div>
                  </details>
                {/if}
              {:else if step === 2}
                <div>
                  <h2
                    bind:this={stepHeading}
                    tabindex="-1"
                    class="text-base font-semibold outline-none"
                  >
                    Workspace sign-in
                  </h2>
                  <p class="text-muted-foreground mt-2 text-sm leading-6">
                    Register Widefleet with your provider. Use this redirect URI, then enter the
                    credentials.
                  </p>
                </div>
                <div class="space-y-2">
                  <p class="text-xs font-medium">Redirect URI</p>
                  {#await callback}<div
                      class="bg-muted h-12 rounded-lg"
                      aria-label="Calculating redirect URI"
                    ></div>{:then url}<CopyValue
                      value={url}
                      label="Copy workspace redirect URI"
                    />{/await}
                </div>
                <div class="space-y-2">
                  <Label for="management-client">Client ID</Label><Input
                    id="management-client"
                    bind:value={identity.management.clientId}
                    required
                    class="h-10"
                  />
                </div>
                <SecretField
                  label="Workspace credentials"
                  bind:value={identity.management.secret}
                />
              {:else}
                <div>
                  <h2
                    bind:this={stepHeading}
                    tabindex="-1"
                    class="text-base font-semibold outline-none"
                  >
                    Published app sign-in
                  </h2>
                  <p class="text-muted-foreground mt-2 text-sm leading-6">
                    This sign-in protects your published apps. Use a separate registration with your
                    provider.
                  </p>
                </div>
                <div class="space-y-2">
                  <p class="text-xs font-medium">Redirect URI</p>
                  <CopyValue value={view.appCallbackUrl} label="Copy app redirect URI" />
                </div>
                <div class="space-y-2">
                  <Label for="apps-client">Client ID</Label><Input
                    id="apps-client"
                    bind:value={identity.apps.clientId}
                    required
                    class="h-10"
                  />
                </div>
                <SecretField label="App sign-in credentials" bind:value={identity.apps.secret} />
                {#if identity.provider.type === "entra"}<p
                    class="text-muted-foreground text-xs leading-6"
                  >
                    Enable group claims in this registration. For users in more than 200 groups, the
                    sign-in service retrieves memberships through Microsoft Graph.
                  </p>
                  <details class="rounded-lg border p-4">
                    <summary class="text-muted-foreground text-xs font-medium"
                      >Group search for coding agents</summary
                    >
                    <div class="mt-4 space-y-4">
                      <div class="flex items-center gap-3">
                        <Checkbox
                          id="directory"
                          checked={identity.directory !== null}
                          onCheckedChange={(enabled) => {
                            identity.directory = enabled
                              ? { clientId: "", secret: { type: "value", value: "" } }
                              : null;
                          }}
                        /><Label for="directory">Connect Microsoft Graph (optional)</Label>
                      </div>
                      {#if identity.directory}<p class="text-muted-foreground text-xs leading-6">
                          This registration needs the GroupMember.Read.All application permission
                          with administrator consent.
                        </p>
                        <div class="space-y-2">
                          <Label for="directory-client">Client ID</Label><Input
                            id="directory-client"
                            bind:value={identity.directory.clientId}
                            required
                          />
                        </div>
                        <SecretField
                          label="Group search credentials"
                          bind:value={identity.directory.secret}
                        />{/if}
                    </div>
                  </details>
                {/if}
              {/if}
              {#if !readonly}<div
                  class="flex flex-wrap items-center justify-between gap-3 border-t pt-5"
                >
                  {#if onboarding && step > 1}<Button
                      variant="ghost"
                      onclick={() => openStep(step - 1)}
                      disabled={busy}><ArrowLeft />Back</Button
                    >{:else}<span class="text-muted-foreground text-xs"
                      >{onboarding ? `Step ${step} of 4` : dirty ? "Unsaved changes" : ""}</span
                    >{/if}<Button id="identity-save" type="submit" disabled={busy}
                    >{busy
                      ? "Saving …"
                      : onboarding && step < 3
                        ? "Continue"
                        : "Save"}{#if onboarding && step < 3}<ArrowRight />{/if}</Button
                  >
                </div>{/if}
            </fieldset>
          </form>
        {:else}
          <section class="space-y-6 rounded-xl border p-5 sm:p-7">
            <div>
              <div
                class="text-primary bg-primary/5 mb-4 grid size-10 place-items-center rounded-xl"
              >
                <ShieldCheck class="size-5" />
              </div>
              <h2
                bind:this={stepHeading}
                tabindex="-1"
                class="text-base font-semibold outline-none"
              >
                {onboarding ? "Verify administrator access" : "Company account"}
              </h2>
              <p class="text-muted-foreground mt-2 text-sm leading-6">
                {onboarding
                  ? "Verify your new access before completing setup. Your existing permissions are preserved."
                  : "Link and verify company sign-in for this administrator account."}
              </p>
            </div>
            {#if dirty}<Feedback>Save your configuration changes before testing sign-in.</Feedback
              >{/if}
            {#if view.settings.identity}
              {#if !data.linked}<p class="text-muted-foreground text-sm leading-6">
                  Link your company account to this administrator account.
                </p>
                <Button disabled={busy || !data.provider || dirty} onclick={() => signIn(true)}
                  >Link company account<ArrowRight /></Button
                >
              {:else if !data.tested}<p class="text-muted-foreground text-sm leading-6">
                  Your account is linked. Sign in with it to verify administrator access.
                </p>
                <Button disabled={busy || !data.provider || dirty} onclick={() => signIn(false)}
                  >Test company sign-in<ArrowRight /></Button
                >
              {:else}<Feedback kind="success"
                  >Company sign-in and administrator access verified successfully.</Feedback
                >{#if onboarding}<p class="text-muted-foreground text-sm leading-6">
                    Completing setup disables password access and closes all local sessions. You can
                    generate a temporary recovery link on the server later.
                  </p>
                  <Button
                    disabled={busy || dirty}
                    onclick={complete}
                    class="h-auto min-h-9 whitespace-normal py-2 text-left"
                    >{#if busy}<LoaderCircle
                        class="animate-spin motion-reduce:animate-none"
                      />{/if}Complete setup and disable password access</Button
                  >{/if}{/if}
              {#if data.linked}<div class="border-t pt-5">
                  <p class="text-muted-foreground mb-3 text-xs leading-6">
                    If you change accounts or providers, you can link another company account to
                    this administrator.
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy || !data.provider || dirty}
                    onclick={() => signIn(true)}
                    class="h-auto min-h-8 whitespace-normal py-2"
                    >Link another company account</Button
                  >
                </div>{/if}
            {:else}<Feedback
                >First configure your identity provider and both sign-in registrations.</Feedback
              ><Button onclick={() => openStep(1)}>Start setup<ArrowRight /></Button>{/if}
          </section>
        {/if}
      </div>
    </div>
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
