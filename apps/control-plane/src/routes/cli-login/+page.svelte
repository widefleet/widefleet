<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import { chooseCliPlatform } from "#lib/cli-login.remote";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import Terminal from "@lucide/svelte/icons/terminal";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let email = $state("");

  let busy = $state(false);

  let message = $state("");

  const proceed = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy) return;
    busy = true;
    message = "";

    try {
      const url = await chooseCliPlatform({ request: data.request, ticket: data.ticket, email });
      window.location.assign(url);
    } catch (cause) {
      message = isHttpError(cause)
        ? cause.body.message
        : "Could not start sign-in. Check your connection and try again.";
      busy = false;
    }
  };
</script>

<svelte:head><title>Connect CLI · Widefleet</title></svelte:head>
<AuthLayout>
  <div class="bg-primary/5 text-primary mb-5 grid size-10 place-items-center rounded-xl">
    <Terminal class="size-5" />
  </div>
  <h1 class="text-2xl font-semibold tracking-tight">Connect your CLI</h1>
  {#if data.status === "authorized"}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Sign-in approved. Your CLI can finish connecting. You can close this window.
    </p>
  {:else if data.status === "denied"}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      This request was denied. Run widefleet login --restart to start again.
    </p>
  {:else}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Enter your email to continue to your Widefleet sign-in. Your company's installation is found
      automatically.
    </p>
    <p class="text-muted-foreground mt-3 text-xs leading-6">
      Request <span class="font-mono">{data.code}</span>. Continue only if you started this request
      in your terminal or coding assistant.
    </p>
    <form onsubmit={proceed} class="mt-6 space-y-4">
      <div class="space-y-2">
        <Label for="cli-email">Email</Label>
        <Input
          id="cli-email"
          type="email"
          bind:value={email}
          autocomplete="email"
          required
          disabled={busy}
        />
      </div>
      {#if message}<Feedback kind="error">{message}</Feedback>{/if}
      <Button type="submit" disabled={busy} class="w-full">
        {busy ? "Finding sign-in …" : "Continue"}<ArrowRight />
      </Button>
    </form>
  {/if}
</AuthLayout>
