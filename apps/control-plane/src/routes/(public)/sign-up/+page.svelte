<script lang="ts">
  import AuthLayout from "@platform/ui/auth-layout";
  import EmailCodeForm from "#shadcn/components/EmailCodeForm.svelte";
  import type { PageData } from "./$types";
  import SocialSignIn from "#shadcn/components/SocialSignIn.svelte";

  let { data }: { data: PageData } = $props();

  let sentTo = $state<string | null>(null);
</script>

<svelte:head><title>Create an account · Widefleet</title></svelte:head>
<AuthLayout class="rounded-xl p-0 sm:p-0">
  <div class="p-6 sm:p-8">
    {#if sentTo === null}
      <h1 class="text-2xl font-semibold leading-tight tracking-tight">Create your account</h1>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        Next, you'll set up your organization and publish your first app.
      </p>
      <SocialSignIn providers={data.socialProviders} next={data.next} register compact />
    {/if}
    <EmailCodeForm next={data.next} register focused bind:sentTo />
  </div>
  {#if sentTo === null}<p
      class="bg-muted/20 text-muted-foreground rounded-b-xl border-t px-6 py-4 text-center text-sm sm:px-8"
    >
      Already have an account? <a
        class="text-foreground font-medium underline-offset-4 hover:underline"
        href={`/sign-in?${new URLSearchParams({ next: data.next })}`}>Sign in</a
      >
    </p>{/if}
</AuthLayout>
