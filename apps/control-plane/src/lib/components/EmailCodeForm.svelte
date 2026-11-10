<script lang="ts">
  import { z } from "zod";
  import { onMount, tick } from "svelte";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
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
    focused = false,
    sentTo = $bindable(null),
  }: {
    next: string;
    initialEmail?: string;
    organizationSlug?: string | null;
    codeDelivery?: "email" | "console";
    register?: boolean;
    publicSignup?: boolean;
    verifyEmail?: boolean;
    focused?: boolean;
    sentTo?: string | null;
  } = $props();

  let email = $state("");

  let name = $state("");

  let otp = $state("");

  let busy = $state(false);

  let resending = $state(false);

  let resendWait = $state(0);

  let resendAt = 0;

  let notice = $state("");

  let ready = $state(false);

  let message = $state("");

  let lastUsed = $state(false);

  let extensionContainer = $state<HTMLDivElement>();

  onMount(() => {
    email = initialEmail;
    ready = true;
    lastUsed = authClient.isLastUsedLoginMethod("email-otp");

    const unmount = extensionContainer
      ? authClientExtension.mountEmailCodeForm?.(extensionContainer)
      : undefined;

    const timer = setInterval(() => {
      if (resendWait > 0) resendWait = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    }, 1000);

    return () => {
      clearInterval(timer);
      unmount?.();
    };
  });

  const oauthRedirect = z.object({ redirect: z.literal(true), url: z.url() });

  const showError = (cause: unknown) => {
    message = isHttpError(cause)
      ? cause.body.message
      : cause instanceof Error
        ? cause.message
        : "Sign-in is temporarily unavailable. Check your connection.";
  };

  const requestCode = async (recipient: string) => {
    const result = await authClient.emailOtp.sendVerificationOtp({
      email: recipient,
      type: "sign-in",
    });

    if (result.error) {
      message = "Could not send a sign-in code. Please try again.";

      return false;
    }

    email = recipient;
    sentTo = recipient;
    otp = "";
    resendAt = Date.now() + 30_000;
    resendWait = 30;

    return true;
  };

  const focusCode = async () => {
    await tick();
    document.getElementById("sign-in-code")?.focus();
  };

  const changeEmail = async () => {
    if (busy) return;
    sentTo = null;
    otp = "";
    message = "";
    notice = "";
    await tick();
    document.getElementById("code-email")?.focus();
  };

  const resendCode = async () => {
    if (!sentTo || busy || resendWait > 0) return;
    busy = true;
    resending = true;
    message = "";
    notice = "";

    try {
      if (await requestCode(sentTo)) notice = "A new code has been requested.";
    } catch (cause) {
      showError(cause);
    } finally {
      busy = false;
      resending = false;
      await focusCode();
    }
  };

  const emailSignIn = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy || (sentTo !== null && otp.length !== 6)) return;
    busy = true;
    message = "";
    notice = "";

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

        await requestCode(recipient);
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
      showError(cause);
    } finally {
      busy = false;

      if (focused && sentTo !== null) await focusCode();
    }
  };
</script>

<form onsubmit={emailSignIn} class={focused && sentTo !== null ? "space-y-6" : "mt-6 space-y-4"}>
  {#if focused && sentTo !== null}
    <div>
      <Button
        variant="ghost"
        disabled={busy}
        onclick={changeEmail}
        class="text-muted-foreground mb-5 -ml-2 gap-1.5 px-2 text-xs"
      >
        <ArrowLeft class="size-3.5" />Back to sign in
      </Button>
      <h1 class="text-2xl font-semibold leading-tight tracking-tight">Check your email</h1>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        {codeDelivery === "console"
          ? "If this address has an invitation or membership, its six-digit code is in the server log."
          : publicSignup
            ? "Enter the six-digit code we sent to your email address."
            : "If this address has an invitation or membership, a six-digit code is on its way."}
      </p>
    </div>
    <div
      class="bg-muted/40 flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2"
    >
      <span class="min-w-0 break-all text-sm">{sentTo}</span>
      <Button
        variant="ghost"
        disabled={busy}
        onclick={changeEmail}
        class="text-muted-foreground -mr-1 shrink-0 px-1 text-xs">Change</Button
      >
    </div>
  {/if}
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
  {#if !focused || sentTo === null}<div class="space-y-2">
      <div class="flex items-center justify-between">
        <Label for="code-email">Email</Label>{#if lastUsed}<span
            class="text-muted-foreground text-xs">Last used</span
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
        class={focused ? "h-11" : undefined}
      />
    </div>{/if}
  {#if sentTo !== null}
    {#if !focused}
      <p class="text-muted-foreground text-xs leading-5">
        {register || publicSignup
          ? "Enter the six-digit code sent to your email. It expires in five minutes."
          : codeDelivery === "console"
            ? "If this address has an invitation or membership, its six-digit code is in the server log."
            : "If this address has an invitation or membership, a six-digit code is on its way."}
      </p>
    {/if}
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <Label for="sign-in-code">{register ? "Verification code" : "Sign-in code"}</Label>
        {#if focused}<span class="text-muted-foreground text-xs">Valid for 5 minutes</span>{/if}
      </div>
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
        class={focused ? "w-full" : undefined}
      >
        {#snippet children({ cells })}
          <InputOTP.Group class={focused ? "w-full gap-2" : undefined}>
            {#each cells as cell (cell)}
              <InputOTP.Slot
                {cell}
                class={focused
                  ? "h-12 min-w-0 flex-1 rounded-lg border text-lg first:rounded-lg last:rounded-lg"
                  : undefined}
              />
            {/each}
          </InputOTP.Group>
        {/snippet}
      </InputOTP.Root>
    </div>
  {/if}
  {#if authClientExtension.mountEmailCodeForm}<div bind:this={extensionContainer}></div>{/if}
  {#if focused && message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if notice}<p role="status" class="text-muted-foreground text-sm">{notice}</p>{/if}
  <Button
    type="submit"
    disabled={busy || !ready || (sentTo !== null && otp.length !== 6)}
    class={focused ? "bg-foreground text-background hover:bg-foreground/90 h-11 w-full" : "w-full"}
    >{busy
      ? "Please wait …"
      : sentTo !== null
        ? register
          ? "Verify email and continue"
          : focused
            ? "Verify and sign in"
            : "Sign in"
        : focused
          ? "Continue with email"
          : "Continue"}</Button
  >
  {#if sentTo !== null && focused}
    <div
      class="bg-muted/20 text-muted-foreground -mx-6 -mb-6 rounded-b-xl border-t px-6 py-4 text-center text-sm sm:-mx-8 sm:-mb-8 sm:px-8"
    >
      Didn't get the code?
      <Button
        type="button"
        variant="ghost"
        disabled={busy || resendWait > 0}
        onclick={resendCode}
        class="text-foreground h-auto min-h-10 px-1 text-sm"
      >
        {resending ? "Sending …" : resendWait > 0 ? `Resend in ${resendWait}s` : "Resend code"}
      </Button>
    </div>
  {:else if sentTo !== null}<Button
      type="button"
      variant="ghost"
      class="w-full"
      disabled={busy}
      onclick={changeEmail}>Use another email or request a new code</Button
    >{/if}
</form>
{#if !focused && message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
