<script lang="ts">
  import { page } from "$app/state";
  import AuthLayout from "@platform/ui/auth-layout";
  import { Button } from "@platform/ui/button";
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
      : page.status === 401
        ? "Your session has ended."
        : page.error?.code === "SSO_REQUIRED"
          ? "Continue with company sign-in."
          : page.error?.code === "ORGANIZATION_REQUIRED"
            ? "Choose an organization."
            : page.status === 403
              ? "You don't have access to this page."
              : page.status === 409
                ? "This action could not be completed."
                : "Something went wrong."}
  </h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    {page.status === 404
      ? "This page does not exist or you don't have access to it. Find your available apps in the overview."
      : page.status === 401
        ? "Sign in again to continue where you left off."
        : page.error?.code === "SSO_REQUIRED"
          ? "Your organization now requires its company account. Sign in with it to continue where you left off."
          : page.error?.code === "ORGANIZATION_REQUIRED"
            ? "Your organization selection is no longer available. Choose one to continue where you left off."
            : page.status === 403
              ? "Contact an administrator if you need access to this page."
              : page.status === 409
                ? page.error?.message
                : "Please try again. If the problem continues, contact an administrator."}
  </p>
  {#if page.status === 401 || page.error?.code}
    <!-- A full page load reaches the request hook, which redirects and keeps this page as the return path. -->
    <Button href={page.url.pathname + page.url.search} data-sveltekit-reload class="mt-6"
      >{page.status === 401 ? "Sign in" : "Continue"}</Button
    >
  {:else if page.status === 409}
    <Button href={page.url.pathname} data-sveltekit-reload variant="outline" class="mt-6">
      Reload page
    </Button>
  {:else}
    <Button href="/" variant="outline" class="mt-6"><ArrowLeft />Back to overview</Button>
  {/if}
</AuthLayout>
