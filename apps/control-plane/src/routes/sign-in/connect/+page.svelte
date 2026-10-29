<script lang="ts">
  import { authClient } from "#lib/auth-client";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import EmailCodeForm from "#shadcn/components/EmailCodeForm.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const label = $derived(data.provider === "google" ? "Google" : "Microsoft");

  const needsProof = $derived(
    !data.failure || ["account_not_linked", "email_verification_required"].includes(data.failure),
  );

  let busy = $state(false);

  let message = $state("");

  const connect = async () => {
    if (busy) return;
    busy = true;
    message = "";

    try {
      const result = await authClient.linkSocial({
        provider: `widefleet-${data.provider}`,
        callbackURL: data.next,
        errorCallbackURL: data.returnTo,
        loginHint: data.email,
      });

      if (result.error) {
        message = "Could not connect your account. Confirm your email again and retry.";
        busy = false;
      }
    } catch {
      message = "Could not connect your account. Check your connection and retry.";
      busy = false;
    }
  };
</script>

<svelte:head><title>Connect {label} · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">Connect {label}</h1>
  {#if !needsProof}
    <div class="mt-5">
      <Feedback kind="error">
        {data.failure === "access_denied"
          ? "Sign-in was cancelled. You can try again or use email."
          : ["email_does_not_match", "EMAIL_DOES_NOT_MATCH"].includes(data.failure ?? "")
            ? `Choose the ${label} account with the same email as your Widefleet account.`
            : ["email_not_found", "user_email_not_found"].includes(data.failure ?? "")
              ? `${label} did not share an email address. Choose another account or sign in with email.`
              : "Your account could not be connected. Please try again or sign in with email."}
      </Feedback>
    </div>
  {/if}
  {#if data.canLink}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Connect your {label} account for
      <span class="text-foreground" data-private>{data.email}</span>. Choose the account with this
      same email address.
    </p>
    <Button class="mt-6 h-10 w-full" disabled={busy} onclick={connect}
      >{busy ? "Opening sign-in …" : `Connect ${label}`}</Button
    >
    <p class="mt-3 text-center text-sm">
      <a
        class="text-muted-foreground underline underline-offset-4"
        href={`${data.returnTo}&verify=email`}>Confirm email again</a
      >
    </p>
  {:else if needsProof && data.emailSignIn}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Confirm your Widefleet email once, then connect your {label} account. After that, you can sign in
      directly with {label}.
    </p>
    <EmailCodeForm
      next={data.returnTo}
      initialEmail={data.email}
      codeDelivery={data.codeDelivery}
      publicSignup={data.publicSignup}
      verifyEmail
    />
  {/if}
  {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
  <p class="mt-6 text-center text-sm">
    <a
      class="underline underline-offset-4"
      href={`/sign-in?${new URLSearchParams({ next: data.next })}`}>Back to sign-in</a
    >
  </p>
</AuthLayout>
