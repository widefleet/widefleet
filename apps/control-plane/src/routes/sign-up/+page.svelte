<script lang="ts">
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import EmailCodeForm from "#shadcn/components/EmailCodeForm.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Create an account · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">Create your account</h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    Verify your email, then set up your organization and publish your first app.
  </p>
  <EmailCodeForm next={data.next} register />
  <p class="text-muted-foreground mt-6 text-center text-sm">
    Already have an account? <a
      href={`/sign-in?${new URLSearchParams({ next: data.next })}`}
      class="text-foreground underline underline-offset-4">Sign in</a
    >
  </p>
</AuthLayout>
