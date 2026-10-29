<script lang="ts">
  import { onMount } from "svelte";
  import { authClient } from "#lib/auth-client";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";

  let {
    providers,
    next,
    register = false,
    emailSignIn = true,
  }: {
    providers: ("google" | "microsoft")[];
    next: string;
    register?: boolean;
    emailSignIn?: boolean;
  } = $props();

  let busy = $state<string | null>(null);

  let message = $state("");

  let lastUsed = $state<string | null>(null);

  onMount(() => {
    lastUsed = authClient.getLastUsedLoginMethod();
  });

  const signIn = async (provider: "google" | "microsoft") => {
    if (busy) return;
    busy = provider;
    message = "";

    try {
      const result = await authClient.signIn.social({
        provider: `widefleet-${provider}`,
        callbackURL: next,
        newUserCallbackURL: register
          ? next
          : `/organizations?${new URLSearchParams({ next: next === "/" ? "/welcome" : next })}`,
        errorCallbackURL: `/sign-in/connect?${new URLSearchParams({ provider, next })}`,
      });

      if (result.error) {
        message = "Could not start sign-in. Please try again.";
        busy = null;
      }
    } catch {
      message = "Sign-in is temporarily unavailable. Check your connection.";
      busy = null;
    }
  };
</script>

{#if providers.length}
  <div class="mt-6 space-y-3">
    {#each providers as provider (provider)}
      <Button
        variant="outline"
        class="h-10 w-full"
        disabled={busy !== null}
        onclick={() => signIn(provider)}
      >
        <img src={`/brand/${provider}.svg`} class="size-4" width="16" height="16" alt="" />
        {busy === provider
          ? "Opening sign-in …"
          : `Continue with ${provider === "google" ? "Google" : "Microsoft"}`}
        {#if lastUsed === provider}<span class="text-muted-foreground ml-auto text-xs font-normal"
            >Last used</span
          >{/if}
      </Button>
    {/each}
  </div>
  {#if message}<div class="mt-4"><Feedback kind="error">{message}</Feedback></div>{/if}
  {#if emailSignIn}<div class="text-muted-foreground mt-6 flex items-center gap-3 text-xs">
      <div class="bg-border h-px flex-1"></div>
      or continue with email
      <div class="bg-border h-px flex-1"></div>
    </div>{/if}
{/if}
