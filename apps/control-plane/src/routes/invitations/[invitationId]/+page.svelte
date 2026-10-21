<script lang="ts">
  import type { PageData } from "./$types";
  import { acceptInvitation } from "#lib/invitations.remote";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Join {data.invitation.organizationName} · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">Join {data.invitation.organizationName}</h1>
  <p class="text-muted-foreground mt-3 text-sm leading-6">
    Your invitation for {data.invitation.email} gives you the {data.invitation.role} role.
  </p>
  {#if data.invitation.status === "pending"}
    <form {...acceptInvitation} class="mt-6 space-y-4">
      <input {...acceptInvitation.fields.invitationId.as("hidden", data.invitation.id)} />
      <FormIssues issues={acceptInvitation.fields.allIssues()} />
      <Button type="submit" disabled={acceptInvitation.pending > 0} class="w-full"
        >Accept invitation</Button
      >
    </form>
  {:else}
    <div class="mt-6">
      <Feedback kind="error"
        >This invitation is {data.invitation.status}. Contact the organization owner if you need a
        new invitation.</Feedback
      >
    </div>
    <Button href="/organizations" class="mt-5 w-full" variant="outline">Your organizations</Button>
  {/if}
</AuthLayout>
