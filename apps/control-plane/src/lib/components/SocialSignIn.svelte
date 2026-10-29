<script lang="ts">
  import { onMount } from "svelte";
  import { authClient } from "#lib/auth-client";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";

  let {
    providers,
    next,
    register = false,
  }: {
    providers: ("google" | "microsoft")[];
    next: string;
    register?: boolean;
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
        {#if provider === "google"}
          <svg viewBox="0 0 24 24" class="size-4" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.23c1.89-1.74 2.99-4.3 2.99-7.36Z"
            />
            <path
              fill="#34A853"
              d="M12 22c2.7 0 4.96-.9 6.61-2.41l-3.23-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"
            />
            <path
              fill="#FBBC05"
              d="M6.41 13.93A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.93V7.48H3.07A10 10 0 0 0 2 12c0 1.61.38 3.14 1.07 4.52l3.34-2.59Z"
            />
            <path
              fill="#EA4335"
              d="M12 5.95c1.47 0 2.79.51 3.83 1.51l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.93 5.48l3.34 2.59C7.2 7.71 9.4 5.95 12 5.95Z"
            />
          </svg>
        {:else}
          <svg viewBox="0 0 21 21" class="size-4" aria-hidden="true">
            <path fill="#f25022" d="M1 1h9v9H1z" /><path fill="#7fba00" d="M11 1h9v9h-9z" />
            <path fill="#00a4ef" d="M1 11h9v9H1z" /><path fill="#ffb900" d="M11 11h9v9h-9z" />
          </svg>
        {/if}
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
  <div class="text-muted-foreground mt-6 flex items-center gap-3 text-xs">
    <div class="bg-border h-px flex-1"></div>
    or continue with email
    <div class="bg-border h-px flex-1"></div>
  </div>
{/if}
