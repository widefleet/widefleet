<script lang="ts">
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import { goto } from "$app/navigation";
  import { authClient } from "#lib/auth-client";
  import { createOwner } from "#lib/settings.remote";

  let name = $state("");

  let email = $state("");

  let password = $state("");

  let busy = $state(false);

  let message = $state("");

  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    message = "";

    try {
      await createOwner({ name, email, password });
      const result = await authClient.signIn.email({ email, password });

      if (result.error) {
        await goto("/sign-in?next=/settings");

        return;
      }

      await goto("/settings");
    } catch (cause) {
      message = cause instanceof Error ? cause.message : "Could not complete setup.";
    } finally {
      busy = false;
    }
  };
</script>

<svelte:head><title>Welcome · Widefleet</title></svelte:head>
<AuthLayout>
  <p class="text-primary mb-3 text-xs font-medium">WELCOME TO WIDEFLEET</p>
  <h1 class="text-2xl font-semibold leading-tight tracking-tight">
    Your first administrator account.
  </h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    Use this account to configure your workspace and company sign-in. Password access will be
    disabled when setup is complete.
  </p>
  <div class="text-muted-foreground mt-6 flex items-center gap-2 text-[11px]">
    <span class="text-foreground font-medium">1. Account</span><ArrowRight class="size-3" /><span
      >2. Sign-in</span
    ><ArrowRight class="size-3" /><span>3. Verify</span>
  </div>
  <form onsubmit={create} class="mt-7 space-y-5">
    <div class="space-y-2">
      <Label for="owner-name">Name</Label><Input
        id="owner-name"
        bind:value={name}
        autocomplete="name"
        required
        maxlength={100}
        class="h-10"
      />
    </div>
    <div class="space-y-2">
      <Label for="owner-email">Email</Label><Input
        id="owner-email"
        bind:value={email}
        type="email"
        autocomplete="email"
        required
        class="h-10"
      />
    </div>
    <div class="space-y-2">
      <Label for="owner-password">Password</Label><Input
        id="owner-password"
        bind:value={password}
        type="password"
        autocomplete="new-password"
        minlength={12}
        maxlength={128}
        required
        class="h-10"
        aria-describedby="password-hint"
      />
      <p id="password-hint" class="text-muted-foreground text-xs">At least 12 characters.</p>
    </div>
    {#if message}<Feedback kind="error">{message}</Feedback>{/if}
    <Button type="submit" disabled={busy} class="h-10 w-full"
      >{busy ? "Creating account …" : "Create account and continue"}<ArrowRight /></Button
    >
  </form>
  <details class="text-muted-foreground mt-6 border-t pt-4 text-xs leading-6">
    <summary>Privacy during setup</summary>
    <p class="mt-3">
      By default, Widefleet shares usage counts, technical configuration and sanitized error reports
      with the Widefleet team through PostHog. You can disable each category independently in
      Settings → Privacy, or before starting with <code class="wrap-anywhere"
        >PLATFORM_USAGE_REPORTING=false</code
      >
      and <code class="wrap-anywhere">PLATFORM_CRASH_REPORTING=false</code>. App content, names and
      personal identifiers are never sent.
    </p>
  </details>
</AuthLayout>
