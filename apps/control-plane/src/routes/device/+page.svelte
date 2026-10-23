<script lang="ts">
  import { authClient } from "#lib/auth-client";
  import { selectCliOrganization } from "#lib/cli-login.remote";
  import { isHttpError } from "@sveltejs/kit";
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Checkbox } from "#shadcn/components/ui/checkbox/index.js";
  import { NativeSelect, NativeSelectOption } from "#shadcn/components/ui/native-select/index.js";
  import Terminal from "@lucide/svelte/icons/terminal";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let code = $state(untrack(() => data.code));

  let authorization = $state<NonNullable<
    Awaited<ReturnType<typeof authClient.device>>["data"]
  > | null>(null);

  let confirmed = $state(false);

  let busy = $state(false);

  let message = $state("");

  let done = $state(false);

  let selectedOrganization = $state(untrack(() => data.selectedOrganization ?? ""));

  const displayed = $derived(
    data.consent
      ? { client_id: "platform-cli", scope: data.consent.scope, resource: data.consent.resource }
      : authorization,
  );

  const verify = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy) return;
    busy = true;
    message = "";

    try {
      const result = await authClient.device({ query: { user_code: code } });

      if (result.error) message = "This code is invalid, expired or already used.";
      else {
        authorization = result.data;
        confirmed = false;
      }
    } catch {
      message = "Could not check this request. Check your connection and try again.";
    } finally {
      busy = false;
    }
  };

  const decide = async (allow: boolean) => {
    if (busy || (allow && !confirmed)) return;
    busy = true;
    message = "";

    try {
      const options = { headers: { "x-widefleet-approval-session": data.sessionId } };

      if (data.consent) {
        if (allow)
          await selectCliOrganization({
            oauthQuery: data.consent.oauthQuery,
            sessionId: data.sessionId,
            organizationId: selectedOrganization,
          });

        const result = await authClient.oauth2.consent(
          { accept: allow, oauth_query: data.consent.oauthQuery },
          options,
        );

        if (result.error) message = result.error.message ?? "Could not complete this request.";

        return;
      }

      const result = allow
        ? await authClient.device.approve({ userCode: code }, options)
        : await authClient.device.deny({ userCode: code }, options);

      if (result.error)
        message =
          result.error.error_description ||
          "Could not complete this request. Please request a new code.";
      else {
        done = true;
        message = allow
          ? "CLI connected. You can close this window."
          : "Request denied. You can close this window.";
      }
    } catch (cause) {
      message = isHttpError(cause)
        ? cause.body.message
        : "This request is temporarily unavailable. Check your connection and try again.";
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Connect CLI · Widefleet</title></svelte:head>
<AuthLayout wide={Boolean(displayed)}>
  <div class="bg-primary/5 text-primary mb-5 grid size-10 place-items-center rounded-xl">
    <Terminal class="size-5" />
  </div>
  <p class="text-muted-foreground mb-2 text-xs">Signed in as {data.name}</p>
  <h1 class="text-2xl font-semibold tracking-tight">Connect CLI</h1>
  {#if done}<div class="mt-6 space-y-5">
      <Feedback kind="success">{message}</Feedback><Button href="/" variant="outline"
        >Back to overview<ArrowRight /></Button
      >
    </div>
  {:else if displayed}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Check that this code matches the code in your terminal or coding assistant.
    </p>
    <p
      class="bg-muted/50 my-6 rounded-xl border py-5 text-center font-mono text-3xl font-medium tracking-[0.2em]"
    >
      {code}
    </p>
    <dl class="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-3 text-xs leading-5">
      <dt class="text-muted-foreground">Application</dt>
      <dd class="wrap-anywhere">{displayed.client_id}</dd>
      <dt class="text-muted-foreground">Platform</dt>
      <dd class="wrap-anywhere">{data.platformUrl}</dd>
      <dt class="text-muted-foreground">Permissions</dt>
      <dd class="wrap-anywhere">{displayed.scope}</dd>
      <dt class="text-muted-foreground">Organizations</dt>
      <dd class="wrap-anywhere">{data.organization ?? "Your Widefleet memberships"}</dd>
      <dt class="text-muted-foreground">API</dt>
      <dd class="wrap-anywhere">
        {Array.isArray(displayed.resource) ? displayed.resource.join(", ") : displayed.resource}
      </dd>
    </dl>
    {#if data.consent}
      <div class="mt-5 space-y-2">
        <Label for="cli-organization">Organization for CLI commands</Label>
        <NativeSelect
          id="cli-organization"
          bind:value={selectedOrganization}
          class="w-full"
          disabled={busy}
        >
          <NativeSelectOption value="" disabled>Select an organization</NativeSelectOption>
          {#each data.organizations as organization (organization.id)}
            <NativeSelectOption value={organization.id} disabled={organization.ssoRequired}
              >{organization.name}{organization.ssoRequired
                ? " — company sign-in required"
                : ""}</NativeSelectOption
            >
          {/each}
        </NativeSelect>
        <p class="text-muted-foreground text-xs leading-5">
          Saved as the default for CLI commands. Your membership permissions remain unchanged.
        </p>
        {#each data.organizations.filter((organization) => organization.ssoRequired) as organization (organization.id)}
          <a
            class="text-primary block text-sm underline"
            href={`/sign-in?organization=${encodeURIComponent(organization.slug)}&next=${encodeURIComponent(page.url.pathname + page.url.search)}`}
            >Sign in to {organization.name}</a
          >
        {/each}
      </div>
    {/if}
    <div class="mt-6 flex items-start gap-3 border-t pt-5">
      <Checkbox id="device-confirm" bind:checked={confirmed} class="mt-1" /><Label
        for="device-confirm"
        class="text-sm leading-6">I started this request on my device and verified the code.</Label
      >
    </div>
    <p class="text-muted-foreground mt-3 text-xs leading-6">
      Only approve requests you started yourself. Do not enter codes from someone else's messages.
    </p>
    <div class="mt-6 flex flex-wrap gap-3">
      <Button
        onclick={() => decide(true)}
        disabled={busy || !confirmed || (Boolean(data.consent) && !selectedOrganization)}
        >{busy ? "Processing request …" : "Authorize CLI"}<ArrowRight /></Button
      ><Button variant="outline" onclick={() => decide(false)} disabled={busy}>Deny</Button>
    </div>
    {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
  {:else}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Enter the code your CLI displays in the terminal.
    </p>
    <form onsubmit={verify} class="mt-6 space-y-4">
      <div class="space-y-2">
        <Label for="device-code">Device code</Label><Input
          id="device-code"
          bind:value={code}
          required
          maxlength={32}
          autocomplete="off"
          spellcheck="false"
          placeholder="XXXX-XXXX"
          class="h-12 font-mono text-lg tracking-widest"
        />
      </div>
      <Button type="submit" disabled={busy} class="h-10 w-full"
        >{busy ? "Checking code …" : "Check code"}<ArrowRight /></Button
      >
    </form>
    {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
    {#if !data.code}
      <details open class="mt-6 border-t pt-4">
        <summary class="text-sm font-medium">Don't have a device code?</summary>
        <p class="text-muted-foreground mt-3 mb-3 text-xs leading-6">
          Start sign-in using the installed Widefleet CLI in your terminal. It will display the code
          for this page.
        </p>
        <CopyValue
          value={`widefleet --url '${page.url.origin}' login`}
          label="Copy sign-in command"
        />
      </details>
    {/if}
    <a href="/" class="text-muted-foreground hover:text-foreground mt-6 inline-block text-xs"
      >Back to overview</a
    >
  {/if}
</AuthLayout>
