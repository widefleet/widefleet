<script lang="ts">
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

  let message = $state("");

  let email = $state("");

  let password = $state("");

  const signIn = async () => {
    if (!data.provider || busy) return;
    busy = true;
    message = "";

    try {
      const result = await authClient.signIn.social({
        provider: data.provider,
        callbackURL: data.next,
      });

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
      else await goto(data.next);
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
      : "Sign in with your company account to continue in your workspace."}
  </p>
  {#if data.provider}<Button onclick={signIn} disabled={busy} class="mt-7 h-10 w-full"
      >{busy ? "Opening sign-in …" : `Sign in with ${data.label}`}<ArrowRight /></Button
    >{/if}
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
  {:else if !data.provider}<div class="mt-5">
      <Feedback kind="error"
        >Company sign-in is temporarily unavailable. Contact your administrator.</Feedback
      >
    </div>{/if}
  {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
</AuthLayout>
