<script lang="ts">
  import { z } from "zod";
  import { onMount } from "svelte";
  import { authClient } from "#lib/auth-client";
  import { goto } from "$app/navigation";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let busy = $state(false);

  let ready = $state(false);

  onMount(() => {
    ready = true;
  });

  let message = $state("");

  let email = $state("");

  let password = $state("");

  let otp = $state("");

  let sent = $state(false);

  const oauthRedirect = z.object({ redirect: z.literal(true), url: z.url() });

  const emailSignIn = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy) return;
    busy = true;
    message = "";

    try {
      if (!sent) {
        const result = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });

        if (result.error) message = "Could not send a sign-in code. Please try again.";
        else sent = true;
      } else {
        const result = await authClient.signIn.emailOtp({ email, otp });

        if (result.error) message = "Invalid or expired code. Request another code and try again.";
        else if (!oauthRedirect.safeParse(result.data).success)
          await goto(data.next, { invalidateAll: true });
      }
    } catch {
      message = "Sign-in is temporarily unavailable. Check your connection.";
    } finally {
      busy = false;
    }
  };

  const signIn = async () => {
    if (!data.provider || busy) return;
    busy = true;
    message = "";

    try {
      const input = { providerId: data.provider, callbackURL: data.next };

      const result = await authClient.signIn.sso(input);

      if (result.error) {
        message = "Could not start sign-in. Please try again.";
        busy = false;
      }
    } catch {
      message = "Sign-in is temporarily unavailable. Check your connection.";
      busy = false;
    }
  };

  const localSignIn = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy) return;
    busy = true;
    message = "";

    try {
      const result = await authClient.signIn.email({ email, password });

      if (result.error) message = "Email or password not recognized.";
      else if (!oauthRedirect.safeParse(result.data).success) await goto(data.next);
    } catch {
      message = "Sign-in is temporarily unavailable. Check your connection.";
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Sign in · Widefleet</title></svelte:head>
<AuthLayout>
  <div class="bg-primary/5 text-primary mb-5 grid size-10 place-items-center rounded-xl">
    <ShieldCheck class="size-5" />
  </div>
  <h1 class="text-2xl font-semibold leading-tight tracking-tight">
    Your internal apps.<br />One shared home.
  </h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    {data.next.startsWith("/device")
      ? "Sign in to review the request from your terminal and connect your CLI."
      : data.organizationName
        ? `Sign in to ${data.organizationName}.`
        : "Sign in to continue to your workspace."}
  </p>
  {#if data.provider}<Button onclick={signIn} disabled={busy} class="mt-7 h-10 w-full"
      >{busy ? "Opening sign-in …" : `Sign in with ${data.label}`}<ArrowRight /></Button
    >{/if}
  {#if data.emailSignIn}
    <form onsubmit={emailSignIn} class="mt-6 space-y-4">
      <div class="space-y-2">
        <Label for="code-email">Email</Label>
        <Input
          id="code-email"
          type="email"
          bind:value={email}
          disabled={!ready}
          readonly={sent}
          autocomplete="email"
          required
        />
      </div>
      {#if sent}
        <p class="text-muted-foreground text-xs leading-5">
          If this address has an invitation or membership, a six-digit code is on its way.
        </p>
        <div class="space-y-2">
          <Label for="sign-in-code">Sign-in code</Label>
          <Input
            id="sign-in-code"
            bind:value={otp}
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern={"[0-9]{6}"}
            minlength={6}
            maxlength={6}
            required
          />
        </div>
      {/if}
      <Button type="submit" disabled={busy || !ready} class="w-full"
        >{busy ? "Please wait …" : sent ? "Sign in" : "Email me a sign-in code"}</Button
      >
      {#if sent}<Button
          type="button"
          variant="ghost"
          class="w-full"
          disabled={busy}
          onclick={() => {
            sent = false;
            otp = "";
          }}>Use another email or request a new code</Button
        >{/if}
    </form>
  {/if}
  <details class="mt-6 border-t pt-5">
    <summary class="text-sm font-medium"
      >{data.provider ? "Sign in to another organization" : "Sign in with company SSO"}</summary
    >
    <form method="GET" class="mt-4 space-y-3">
      <input type="hidden" name="next" value={data.next} />
      <Label for="organization-slug">Organization slug</Label>
      <Input
        id="organization-slug"
        name="organization"
        required
        value={data.organizationSlug ?? ""}
        placeholder="acme"
      />
      <Button type="submit" variant="outline" class="w-full">Continue</Button>
      {#if data.organizationSlug && !data.provider}<Feedback kind="error"
          >Company sign-in is not configured for this organization.</Feedback
        >{/if}
    </form>
  </details>
  {#if data.localPasswordEnabled}
    <details open={!data.provider} class="mt-6 border-t pt-5">
      <summary class="text-sm font-medium">Continue setup</summary>
      <p class="text-muted-foreground mt-2 text-xs leading-6">
        Use the administrator account you created during setup.
      </p>
      <form onsubmit={localSignIn} class="mt-5 space-y-4">
        <div class="space-y-2">
          <Label for="login-email">Email</Label><Input
            id="login-email"
            type="email"
            bind:value={email}
            autocomplete="username"
            required
            class="h-10"
          />
        </div>
        <div class="space-y-2">
          <Label for="login-password">Password</Label><Input
            id="login-password"
            type="password"
            bind:value={password}
            autocomplete="current-password"
            required
            class="h-10"
          />
        </div>
        <Button
          type="submit"
          variant={data.provider ? "outline" : "default"}
          disabled={busy}
          class="h-auto min-h-10 w-full whitespace-normal py-2"
          >Sign in as setup administrator</Button
        >
      </form>
    </details>
  {:else if !data.provider && !data.emailSignIn}<div class="mt-5">
      <Feedback kind="error"
        >Company sign-in is temporarily unavailable. Contact your administrator.</Feedback
      >
    </div>{/if}
  {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
</AuthLayout>
