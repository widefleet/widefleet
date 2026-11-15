<script lang="ts">
  import { onMount } from "svelte";
  import { isHttpError } from "@sveltejs/kit";
  import { chooseCliPlatform, inspectCliLogin } from "#lib/cli-login.remote";
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

  let selected = $state(false);

  let message = $state("");

  const failure = (cause: unknown) =>
    isHttpError(cause)
      ? cause.body.message
      : "Could not continue sign-in. Check your connection and reload this page.";

  const continueToDevice = (uri: string) => {
    const url = new URL(uri);

    if (email) url.searchParams.set("email", email);
    window.location.assign(url.href);
  };

  onMount(() => {
    selected = Boolean(data.platformUrl);

    if (data.verificationUri) continueToDevice(data.verificationUri);
    let stopped = false;
    let checking = false;
    const status = inspectCliLogin({ request: data.request, ticket: data.ticket });

    const timer = setInterval(async () => {
      if (!selected || checking) return;
      checking = true;

      try {
        await status.refresh();
        const login = await status;

        if (!stopped && login.verificationUri) continueToDevice(login.verificationUri);
      } catch (cause) {
        if (!stopped) message = failure(cause);
        clearInterval(timer);
      } finally {
        checking = false;
      }
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  const proceed = async (event: SubmitEvent) => {
    event.preventDefault();

    if (busy) return;
    busy = true;
    message = "";

    try {
      const login = await chooseCliPlatform({ request: data.request, ticket: data.ticket, email });
      selected = true;

      if (login.verificationUri) continueToDevice(login.verificationUri);
    } catch (cause) {
      message = failure(cause);
    } finally {
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
  {#if selected}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Waiting for your CLI to prepare sign-in. Keep the login command running; this page will
      continue automatically.
    </p>
  {:else}
    <p class="text-muted-foreground mt-3 text-sm leading-6">
      Enter your email to find your Widefleet installation. Continue only if you started this login
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
      <Button type="submit" disabled={busy} class="w-full"
        >{busy ? "Finding sign-in …" : "Continue"}<ArrowRight /></Button
      >
    </form>
  {/if}
  {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
</AuthLayout>
