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
    compact = false,
  }: {
    providers: ("google" | "microsoft")[];
    next: string;
    register?: boolean;
    emailSignIn?: boolean;
    compact?: boolean;
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
  <div class={compact ? "mt-6 grid grid-cols-2 items-start gap-2.5" : "mt-6 space-y-3"}>
    {#each providers as provider (provider)}
      <div class={compact && providers.length === 1 ? "col-span-2" : undefined}>
        <Button
          variant="outline"
          class={compact ? "h-11 w-full gap-2 px-2 text-sm" : "h-10 w-full"}
          aria-label={`Continue with ${provider === "google" ? "Google" : "Microsoft"}`}
          aria-describedby={compact && lastUsed === provider ? `last-used-${provider}` : undefined}
          disabled={busy !== null}
          onclick={() => signIn(provider)}
        >
          <img src={`/brand/${provider}.svg`} class="size-4" width="16" height="16" alt="" />
          {busy === provider
            ? compact
              ? "Opening …"
              : "Opening sign-in …"
            : `${compact ? "" : "Continue with "}${provider === "google" ? "Google" : "Microsoft"}`}
          {#if lastUsed === provider && !compact}<span
              class="text-muted-foreground ml-auto text-xs font-normal">Last used</span
            >{/if}
        </Button>
        {#if compact && lastUsed === provider}<p
            id={`last-used-${provider}`}
            class="text-muted-foreground mt-1.5 text-center text-xs"
          >
            Last used
          </p>{/if}
      </div>
    {/each}
  </div>
  {#if message}<div class="mt-4"><Feedback kind="error">{message}</Feedback></div>{/if}
  {#if emailSignIn}<div class="text-muted-foreground mt-6 flex items-center gap-3 text-xs">
      <div class="bg-border h-px flex-1"></div>
      or continue with email
      <div class="bg-border h-px flex-1"></div>
    </div>{/if}
{/if}
