<script lang="ts">
  import { authClient } from "#lib/auth-client";
  import { resetClientContext } from "#lib/analytics-client";
  import EmailCodeForm from "#shadcn/components/EmailCodeForm.svelte";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  $effect(() => {
    if (data.signedOut) resetClientContext();
  });

  let busy = $state(false);

  let message = $state("");

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
  {#if data.provider && (data.organizationSlug || !data.emailSignIn)}<Button
      onclick={signIn}
      disabled={busy}
      class="mt-7 h-10 w-full"
      >{busy ? "Opening sign-in …" : `Sign in with ${data.label}`}<ArrowRight /></Button
    >{/if}
  {#if data.emailSignIn}
    <EmailCodeForm
      next={data.next}
      initialEmail={data.email}
      organizationSlug={data.organizationSlug}
      codeDelivery={data.codeDelivery}
      publicSignup={data.publicSignup}
    />
  {/if}
  {#if data.publicSignup}<p class="text-muted-foreground mt-5 text-center text-sm">
      New to Widefleet? <a
        class="text-foreground underline underline-offset-4"
        href={`/sign-up?${new URLSearchParams({ next: data.next })}`}>Create an account</a
      >
    </p>{/if}
  {#if !data.provider && !data.emailSignIn}<div class="mt-5">
      <Feedback kind="error"
        >Company sign-in is temporarily unavailable. Contact your administrator.</Feedback
      >
    </div>{/if}
  {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
</AuthLayout>
