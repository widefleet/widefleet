<script lang="ts">
  import { page } from "$app/state";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
</script>

<svelte:head><title>{page.status} · Widefleet</title></svelte:head>
<AuthLayout>
  <div class="bg-muted text-muted-foreground mb-5 grid size-10 place-items-center rounded-xl">
    <CircleAlert class="size-5" />
  </div>
  <p class="text-muted-foreground mb-2 text-xs">Error {page.status}</p>
  <h1 class="text-2xl font-semibold tracking-tight">
    {page.status === 404
      ? "Nothing here yet."
      : page.status === 403
        ? "You don't have access to this page."
        : "Something went wrong."}
  </h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    {page.status === 404
      ? "This page does not exist or you don't have access to it. Find your available apps in the overview."
      : page.status === 403
        ? "Contact an administrator if you need access to this page."
        : "Please try again. If the problem continues, contact an administrator."}
  </p>
  <Button href="/" variant="outline" class="mt-6"><ArrowLeft />Back to overview</Button>
</AuthLayout>
