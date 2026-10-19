<script lang="ts">
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { selectOrganization } from "#lib/organizations.remote";
  import { authClient } from "#lib/auth-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let message = $state("");

  let pending = $state(false);

  const signOut = async () => {
    pending = true;
    message = "";

    try {
      const result = await authClient.signOut();

      if (result.error) message = "Could not sign out. Please try again.";
      else window.location.assign("/sign-in");
    } catch {
      message = "Could not sign out. Check your connection.";
    } finally {
      pending = false;
    }
  };
</script>

<svelte:head><title>Choose organization · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">Choose an organization</h1>
  <p class="text-muted-foreground mt-2 text-sm">
    {data.organizations.length
      ? "Choose where you want to work."
      : "Your account has no available organizations. Ask your administrator to grant access."}
  </p>
  <div class="mt-6 space-y-2">
    {#each data.organizations as organization (organization.id)}
      {@const selection = selectOrganization.for(organization.id)}
      <form
        {...selection.enhance(async ({ submit }) => {
          if (pending) return;
          pending = true;
          message = "";
          try {
            await submit();
            // A full navigation drops cached queries and forms from the previous organization.
            if (selection.result?.selected) window.location.assign("/");
          } catch {
            message = "Could not select this organization. Refresh the page and try again.";
          } finally {
            pending = false;
          }
        })}
      >
        <input {...selection.fields.organizationId.as("hidden", organization.id)} />
        <Button
          type="submit"
          variant="outline"
          class="h-auto w-full justify-between px-4 py-3"
          disabled={pending}
        >
          <span class="truncate">{organization.name}</span>
          <span class="text-muted-foreground text-xs capitalize">{organization.role}</span>
        </Button>
      </form>
    {/each}
  </div>
  {#if message}<div class="mt-4"><Feedback kind="error">{message}</Feedback></div>{/if}
  <Button variant="ghost" class="mt-6 w-full" onclick={signOut} disabled={pending}>Sign out</Button>
</AuthLayout>
