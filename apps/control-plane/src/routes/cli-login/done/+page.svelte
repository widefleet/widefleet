<script lang="ts">
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>CLI sign-in · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">
    {data.denied ? "Request denied" : "Sign-in approved"}
  </h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    {data.denied
      ? "Your CLI has not been connected. You can close this window."
      : "Return to your terminal or coding assistant. Your CLI can now finish connecting."}
  </p>
</AuthLayout>
