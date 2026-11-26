<script lang="ts">
  import { authClient } from "#lib/auth-client";
  import { onMount, untrack } from "svelte";
  import { page } from "$app/state";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import AuthLayout from "@platform/ui/auth-layout";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import Check from "@lucide/svelte/icons/check";
  import Terminal from "@lucide/svelte/icons/terminal";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // A link from the sign-in flow carries its code. Only people who open this page
  // themselves type one in.
  const linked = untrack(() => Boolean(data.code));

  let code = $state(untrack(() => data.code));

  let authorization = $state.raw<NonNullable<
    Awaited<ReturnType<typeof authClient.device>>["data"]
  > | null>(null);

  let checking = $state(linked);

  let busy = $state(false);

  let message = $state("");

  let outcome = $state<"approved" | "denied" | null>(null);

  // Protocol scopes describe the session itself, not what it may do.
  const sessionScopes = new Set(["openid", "profile", "offline_access"]);

  const permissions = new Map([
    ["platform:read", "See apps, deployments and settings"],
    ["platform:write", "Create, change and publish apps and change settings your role allows"],
    ["network:manage", "Manage the network access of apps"],
  ]);

  const granted = $derived(
    String(authorization?.scope ?? "")
      .split(" ")
      .filter((scope) => scope && !sessionScopes.has(scope))
      .map((scope) => permissions.get(scope) ?? scope),
  );

  const check = async () => {
    busy = true;
    message = "";

    try {
      const result = await authClient.device({ query: { user_code: code } });

      if (result.error)
        message = linked
          ? "This sign-in request is invalid, expired or already used. Start the sign-in again."
          : "This code is invalid, expired or already used.";
      else authorization = result.data;
    } catch {
      message = "Could not check this request. Check your connection and reload this page.";
    } finally {
      busy = false;
      checking = false;
    }
  };

  onMount(() => {
    if (linked) void check();
  });

  const verify = async (event: SubmitEvent) => {
    event.preventDefault();

    if (!busy) await check();
  };

  const decide = async (allow: boolean) => {
    if (busy) return;
    busy = true;
    message = "";

    try {
      const options = { headers: { "x-widefleet-approval-session": data.sessionId } };

      const result = allow
        ? await authClient.device.approve({ userCode: code }, options)
        : await authClient.device.deny({ userCode: code }, options);

      if (result.error)
        message =
          result.error.error_description ||
          "Could not complete this request. Start the sign-in again.";
      else outcome = allow ? "approved" : "denied";
    } catch {
      message = "This request is temporarily unavailable. Check your connection and try again.";
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>{linked ? "Confirm sign-in" : "Connect CLI"} · Widefleet</title></svelte:head>
<AuthLayout>
  {#if !linked}<div
      class="bg-primary/5 text-primary mb-5 grid size-10 place-items-center rounded-xl"
    >
      <Terminal class="size-5" />
    </div>{/if}
  {#if outcome}
    <div role="status">
      <h1 class="text-2xl font-semibold tracking-tight">
        {outcome === "approved" ? "Signed in" : "Sign-in denied"}
      </h1>
      <p class="text-muted-foreground mt-3 text-sm leading-6">
        {outcome === "approved"
          ? "You can close this window."
          : "Nothing was connected. You can close this window."}
      </p>
    </div>
  {:else if authorization}
    <p class="text-muted-foreground mb-2 text-xs">Signed in as {data.name}</p>
    <h1 class="text-2xl font-semibold tracking-tight">Confirm sign-in</h1>
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      This sign-in gets access to <span class="text-foreground font-medium"
        >{data.organization ?? "your Widefleet organizations"}</span
      >
      as {data.name}. It can:
    </p>
    <ul class="mt-4 space-y-2 text-sm leading-6">
      {#each granted as permission (permission)}
        <li class="flex items-start gap-2.5">
          <Check class="text-muted-foreground mt-1 size-4 shrink-0" />{permission}
        </li>
      {/each}
    </ul>
    <div class="mt-7 flex flex-wrap gap-3">
      <Button
        onclick={() => decide(true)}
        disabled={busy}
        class="bg-foreground text-background hover:bg-foreground/90">Confirm<ArrowRight /></Button
      ><Button variant="outline" onclick={() => decide(false)} disabled={busy}>Deny</Button>
    </div>
    <p class="text-muted-foreground mt-4 text-xs leading-5">
      Only confirm if you just started this sign-in or asked for it.
    </p>
    {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
    <details class="mt-6 border-t pt-4">
      <summary class="text-muted-foreground cursor-pointer text-xs">Details</summary>
      <dl class="mt-3 grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs leading-5">
        <dt class="text-muted-foreground">Request code</dt>
        <dd class="font-mono">{code}</dd>
        <dt class="text-muted-foreground">Application</dt>
        <dd class="wrap-anywhere">{authorization.client_id}</dd>
        <dt class="text-muted-foreground">Scopes</dt>
        <dd class="wrap-anywhere">{authorization.scope}</dd>
        <dt class="text-muted-foreground">API</dt>
        <dd class="wrap-anywhere">
          {Array.isArray(authorization.resource)
            ? authorization.resource.join(", ")
            : authorization.resource}
        </dd>
      </dl>
    </details>
  {:else if linked}
    <h1 class="text-2xl font-semibold tracking-tight">Confirm sign-in</h1>
    {#if checking}<p class="text-muted-foreground mt-3 text-sm leading-6">
        Loading the request …
      </p>{/if}
    {#if message}<div class="mt-6"><Feedback kind="error">{message}</Feedback></div>{/if}
  {:else}
    <p class="text-muted-foreground mb-2 text-xs">Signed in as {data.name}</p>
    <h1 class="text-2xl font-semibold tracking-tight">Connect CLI</h1>
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
    <a href="/" class="text-muted-foreground hover:text-foreground mt-6 inline-block text-xs"
      >Back to overview</a
    >
  {/if}
</AuthLayout>
