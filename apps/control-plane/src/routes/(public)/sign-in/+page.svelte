<script lang="ts">
  import { authClient } from "#lib/auth-client";
  import { resetClientContext } from "#lib/analytics-client";
  import EmailCodeForm from "#shadcn/components/EmailCodeForm.svelte";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import type { PageData } from "./$types";
  import { onMount } from "svelte";
  import SocialSignIn from "#shadcn/components/SocialSignIn.svelte";

  let { data }: { data: PageData } = $props();

  $effect(() => {
    if (data.signedOut) resetClientContext();
  });

  let busy = $state(false);

  let message = $state("");

  let lastUsed = $state<string | null>(null);

  let sentTo = $state<string | null>(null);

  onMount(() => {
    lastUsed = authClient.getLastUsedLoginMethod();
  });

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
</script>

<svelte:head><title>Sign in · Widefleet</title></svelte:head>
<AuthLayout class="rounded-xl p-0 sm:p-0">
  <div class="p-6 sm:p-8">
    {#if sentTo === null}
      <h1 class="break-words text-2xl font-semibold leading-tight tracking-tight">
        Sign in to {data.organizationName ?? "Widefleet"}
      </h1>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        {data.next.startsWith("/device")
          ? "Sign in to review the request from your terminal and connect your CLI."
          : "Choose how to continue to your workspace."}
      </p>
      {#if data.provider && (data.organizationSlug || !data.emailSignIn)}<Button
          onclick={signIn}
          disabled={busy}
          class="bg-foreground text-background hover:bg-foreground/90 mt-6 h-auto min-h-11 w-full whitespace-normal py-2"
          ><span class="min-w-0 break-words"
            >{busy ? "Opening sign-in …" : `Sign in with ${data.label}`}</span
          >{#if lastUsed === "sso"}<span class="ml-auto text-xs font-normal">Last used</span
            >{/if}<ArrowRight /></Button
        >{/if}
      <SocialSignIn
        providers={data.socialProviders}
        next={data.next}
        emailSignIn={data.emailSignIn}
        compact
      />
      {#if data.error}<div class="mt-5">
          <Feedback kind="error">Sign-in could not be completed. Please try again.</Feedback>
        </div>{/if}
      {#if !data.provider && !data.emailSignIn && !data.socialProviders.length}<div class="mt-5">
          <Feedback kind="error"
            >Company sign-in is temporarily unavailable. Contact your administrator.</Feedback
          >
        </div>{/if}
      {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
    {/if}
    {#if data.emailSignIn}
      <EmailCodeForm
        next={data.next}
        initialEmail={data.email}
        organizationSlug={data.organizationSlug}
        codeDelivery={data.codeDelivery}
        publicSignup={data.publicSignup}
        focused
        bind:sentTo
      />
    {/if}
  </div>
  {#if data.publicSignup && sentTo === null}<p
      class="bg-muted/20 text-muted-foreground rounded-b-xl border-t px-6 py-4 text-center text-sm sm:px-8"
    >
      New to Widefleet? <a
        class="text-foreground font-medium underline-offset-4 hover:underline"
        href={`/sign-up?${new URLSearchParams({ next: data.next })}`}>Create an account</a
      >
    </p>{/if}
</AuthLayout>
