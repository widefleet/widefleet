<script lang="ts">
  import { z } from "zod";
  import { onMount } from "svelte";
  import { REGEXP_ONLY_DIGITS } from "bits-ui";
  import { isHttpError } from "@sveltejs/kit";
  import { authClientExtension } from "#auth-client-extension";
  import { authClient } from "#lib/auth-client";
  import { findSignInDestination } from "#lib/sign-in.remote";
  import { goto } from "$app/navigation";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import * as InputOTP from "#shadcn/components/ui/input-otp/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";

  let {
    next,
    initialEmail = "",
    organizationSlug = null,
    codeDelivery = "email",
    register = false,
    publicSignup = false,
    verifyEmail = false,
  }: {
    next: string;
    initialEmail?: string;
    organizationSlug?: string | null;
    codeDelivery?: "email" | "console";
    register?: boolean;
    publicSignup?: boolean;
    verifyEmail?: boolean;
  } = $props();

  let email = $state("");

  let name = $state("");

  let otp = $state("");

  let sentTo = $state<string | null>(null);

  let busy = $state(false);

  let ready = $state(false);

  let message = $state("");

  let lastUsed = $state(false);

  let extensionContainer = $state<HTMLDivElement>();

  onMount(() => {
    email = initialEmail;
    ready = true;
    lastUsed = authClient.isLastUsedLoginMethod("email-otp");

    return extensionContainer
      ? authClientExtension.mountEmailCodeForm?.(extensionContainer)
      : undefined;
  });

  const oauthRedirect = z.object({ redirect: z.literal(true), url: z.url() });

  const emailSignIn = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy || (sentTo !== null && otp.length !== 6)) return;
    busy = true;
    message = "";

    try {
      if (sentTo === null) {
        const recipient = email.trim().toLowerCase();

        const destination =
          register || organizationSlug || verifyEmail
            ? null
            : await findSignInDestination({ email: recipient, next });

        if (destination?.url) {
          window.location.assign(destination.url);

          return;
        }

        if (destination?.provider) {
          const result = await authClient.signIn.sso({
            providerId: destination.provider,
            email: recipient,
            callbackURL: next,
          });

          if (result.error) message = "Could not start sign-in. Please try again.";

          return;
        }

        const result = await authClient.emailOtp.sendVerificationOtp({
          email: recipient,
          type: "sign-in",
        });

        if (result.error) message = "Could not send a sign-in code. Please try again.";
        else {
          email = recipient;
          sentTo = recipient;
        }
      } else {
        const input: Parameters<typeof authClient.signIn.emailOtp>[0] = {
          email: sentTo,
          otp,
        };

        if (register) input["name"] = name.trim();
        const result = await authClient.signIn.emailOtp(input);

        if (result.error) message = "Invalid or expired code. Request another code and try again.";
        else if (!oauthRedirect.safeParse(result.data).success)
          await goto(next, { invalidateAll: true });
      }
    } catch (cause) {
      message = isHttpError(cause)
        ? cause.body.message
        : cause instanceof Error
          ? cause.message
          : "Sign-in is temporarily unavailable. Check your connection.";
    } finally {
      busy = false;
    }
  };
</script>

<form onsubmit={emailSignIn} class="mt-6 space-y-4">
  {#if register}
    <div class="space-y-2">
      <Label for="signup-name">Your name</Label>
      <Input
        id="signup-name"
        bind:value={name}
        autocomplete="name"
        required
        maxlength={100}
        disabled={busy || sentTo !== null}
      />
    </div>
  {/if}
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <Label for="code-email">Email</Label>{#if lastUsed}<span class="text-muted-foreground text-xs"
          >Last used</span
        >{/if}
    </div>
    <Input
      id="code-email"
      type="email"
      bind:value={email}
      disabled={!ready || busy}
      readonly={sentTo !== null}
      autocomplete="email"
      required
    />
  </div>
  {#if sentTo !== null}
    <p class="text-muted-foreground text-xs leading-5">
      {register || publicSignup
        ? "Enter the six-digit code sent to your email. It expires in five minutes."
        : codeDelivery === "console"
          ? "If this address has an invitation or membership, its six-digit code is in the server log."
          : "If this address has an invitation or membership, a six-digit code is on its way."}
    </p>
    <div class="space-y-2">
      <Label for="sign-in-code">{register ? "Verification code" : "Sign-in code"}</Label>
      <InputOTP.Root
        inputId="sign-in-code"
        bind:value={otp}
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern={REGEXP_ONLY_DIGITS}
        minlength={6}
        maxlength={6}
        disabled={busy}
        required
      >
        {#snippet children({ cells })}
          <InputOTP.Group>
            {#each cells as cell (cell)}
              <InputOTP.Slot {cell} />
            {/each}
          </InputOTP.Group>
        {/snippet}
      </InputOTP.Root>
    </div>
  {/if}
  {#if authClientExtension.mountEmailCodeForm}<div bind:this={extensionContainer}></div>{/if}
  <Button
    type="submit"
    disabled={busy || !ready || (sentTo !== null && otp.length !== 6)}
    class="w-full"
    >{busy
      ? "Please wait …"
      : sentTo !== null
        ? register
          ? "Verify email and continue"
          : "Sign in"
        : "Continue"}</Button
  >
  {#if sentTo !== null}<Button
      type="button"
      variant="ghost"
      class="w-full"
      disabled={busy}
      onclick={() => {
        sentTo = null;
        otp = "";
      }}>Use another email or request a new code</Button
    >{/if}
</form>
{#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
