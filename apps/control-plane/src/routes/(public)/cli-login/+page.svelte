<script lang="ts">
  import { onMount } from "svelte";
  import { isHttpError } from "@sveltejs/kit";
  import { chooseCliPlatform, inspectCliLogin } from "#lib/cli-login.remote";
  import AuthLayout from "@platform/ui/auth-layout";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let message = $state("");

  const failure = (cause: unknown) =>
    isHttpError(cause)
      ? cause.body.message
      : "Could not continue sign-in. Check your connection and reload this page.";

  // The company's own sign-in keeps the address the person already entered.
  const continueToDevice = (uri: string) => {
    const url = new URL(uri);

    if (data.email) url.searchParams.set("email", data.email);
    window.location.assign(url.href);
  };

  onMount(() => {
    if (data.verificationUri) {
      continueToDevice(data.verificationUri);

      return;
    }

    let stopped = false;
    let checking = false;
    const status = inspectCliLogin({ request: data.request, ticket: data.ticket });

    const timer = setInterval(async () => {
      if (checking) return;
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

    if (!data.platformUrl)
      chooseCliPlatform({ request: data.request, ticket: data.ticket }).catch((cause: unknown) => {
        if (!stopped) message = failure(cause);
        clearInterval(timer);
      });

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });
</script>

<svelte:head><title>Sign in · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">Sign in to Widefleet</h1>
  {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>
  {:else}<p class="text-muted-foreground mt-3 text-sm leading-6">One moment …</p>{/if}
</AuthLayout>
