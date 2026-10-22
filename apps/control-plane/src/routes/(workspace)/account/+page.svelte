<script lang="ts">
  import { page } from "$app/state";
  import { getCompanyAccount } from "#lib/account.remote";
  import { authClient } from "#lib/auth-client";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";

  const account = $derived(await getCompanyAccount());

  let busy = $state(false);

  let message = $state("");

  const signIn = async () => {
    if (!account.provider) return;
    busy = true;
    message = "";

    try {
      const input = {
        providerId: account.provider,
        callbackURL: "/account",
        errorCallbackURL: "/account?error=sso",
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
</script>

<svelte:head><title>Your account · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-6">
  <PageHeading
    title="Your account"
    description="Manage your sign-in for the selected organization."
  />
  {#if message || page.url.searchParams.has("error")}
    <Feedback kind="error"
      >{message ||
        "Company sign-in failed. Try again or contact your organization administrator."}</Feedback
    >
  {/if}
  <section class="space-y-4 rounded-xl border p-5">
    <h2 class="font-medium">Company account</h2>
    {#if account.provider}
      <p class="text-muted-foreground text-sm">{account.label}</p>
      {#if account.tested}
        <Feedback kind="success">You are signed in with your company account.</Feedback>
      {:else if account.linked}
        <p class="text-muted-foreground text-sm">
          Your company account is linked. You can use it to sign in to this organization.
        </p>
        <Button disabled={busy} onclick={() => signIn()}>Use company sign-in</Button>
      {:else}
        <p class="text-muted-foreground text-sm">
          Sign in with your company account. Verified company email addresses keep their existing
          memberships.
        </p>
        <Button disabled={busy} onclick={() => signIn()}>Use company sign-in</Button>
      {/if}
    {:else}
      <p class="text-muted-foreground text-sm">
        Your organization has not configured company sign-in.
      </p>
    {/if}
  </section>
</div>
