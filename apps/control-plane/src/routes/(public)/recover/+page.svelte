<script lang="ts">
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { authClient } from "#lib/auth-client";

  let message = $state("Checking recovery access …");

  onMount(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", window.location.pathname);

    if (!token) {
      message = "This recovery link is incomplete.";

      return;
    }

    void authClient.oneTimeToken
      .verify({ token })
      .then(async (result) => {
        if (result.error)
          message =
            "This link has expired or has already been used. Generate a new link on the server.";
        else await goto("/settings");
      })
      .catch(() => {
        message = "Recovery access is temporarily unavailable.";
      });
  });
</script>

<svelte:head
  ><title>Recovery · Widefleet</title><meta name="referrer" content="no-referrer" /></svelte:head
>
<AuthLayout
  ><p class="text-primary mb-3 text-xs font-medium">RECOVERY</p>
  <h1 class="text-2xl font-semibold tracking-tight">Restore administrator access</h1>
  <p role="status" class="text-muted-foreground mt-4 text-sm leading-6">{message}</p>
  <Button href="/sign-in" variant="outline" class="mt-6">Back to sign-in</Button></AuthLayout
>
