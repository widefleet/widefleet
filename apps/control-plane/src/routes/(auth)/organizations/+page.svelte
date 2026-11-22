<script lang="ts">
  import FormIssues from "#shadcn/FormIssues.svelte";
  import AuthLayout from "@platform/ui/auth-layout";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "@platform/ui/button";
  import { resetClientContext } from "#lib/analytics-client";
  import { createOrganization } from "#lib/organizations.remote";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import { authClient } from "#lib/auth-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let message = $state("");

  let pending = $state(false);

  let creating = $state(false);

  const creationIssues = $derived(createOrganization.fields.allIssues());

  const signOut = async () => {
    pending = true;
    message = "";

    try {
      const result = await authClient.signOut();

      if (result.error) message = "Could not sign out. Please try again.";
      else {
        resetClientContext();
        window.location.assign("/sign-in");
      }
    } catch {
      message = "Could not sign out. Check your connection.";
    } finally {
      pending = false;
    }
  };
</script>

<svelte:head><title>Choose organization · Widefleet</title></svelte:head>
<AuthLayout>
  <h1 class="text-2xl font-semibold tracking-tight">
    {!data.organizations.length && data.canCreateOrganization
      ? "Create your organization"
      : "Choose an organization"}
  </h1>
  <p class="text-muted-foreground mt-2 text-sm">
    {data.organizations.length
      ? data.connecting
        ? "Choose the organization whose apps you want to connect."
        : "Choose where you want to work."
      : data.canCreateOrganization
        ? "Give your workspace a name. You can invite your team later."
        : "Your account has no available organizations. Ask your administrator to grant access."}
  </p>
  <div class="mt-6 space-y-2">
    {#each data.organizations as organization (organization.id)}
      <!-- Choosing only opens the organization; the destination names it in its address. -->
      <Button
        href={organization.ssoRequired
          ? `/sign-in?${new URLSearchParams({ organization: organization.slug, next: organization.destination })}`
          : organization.destination}
        variant="outline"
        class="h-auto w-full justify-between px-4 py-3"
      >
        <span class="truncate">{organization.name}</span>
        <span class="text-muted-foreground text-xs" class:capitalize={!organization.ssoRequired}
          >{organization.ssoRequired ? "Company SSO" : organization.role}</span
        >
      </Button>
    {/each}
  </div>
  {#if data.canCreateOrganization || creationIssues?.length}
    {#if data.organizations.length && !creating && !creationIssues?.length}
      <Button variant="outline" class="mt-4 w-full" onclick={() => (creating = true)}
        >Set up your own organization</Button
      >
    {:else}
      <form {...createOrganization} class="mt-6 space-y-4">
        <FormIssues issues={creationIssues} />
        <input {...createOrganization.fields.next.as("hidden", data.next)} />
        <div class="space-y-2">
          <Label for="organization-name">Organization name</Label><Input
            id="organization-name"
            {...createOrganization.fields.name.as("text")}
            required
            maxlength={200}
            autocomplete="organization"
            disabled={pending || createOrganization.pending > 0}
          />
        </div>
        <div class="space-y-2">
          <Label for="organization-slug">Organization URL name</Label><Input
            id="organization-slug"
            {...createOrganization.fields.slug.as("text")}
            required
            maxlength={50}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder="my-team"
            disabled={pending || createOrganization.pending > 0}
          />
          <p class="text-muted-foreground text-xs">
            Up to 50 lowercase letters, numbers and hyphens. Used in your apps’ addresses.
          </p>
        </div>
        <Button type="submit" class="w-full" disabled={pending || createOrganization.pending > 0}
          >{createOrganization.pending
            ? "Preparing your organization …"
            : "Create organization"}</Button
        >
      </form>
    {/if}
  {/if}
  {#if message}<div class="mt-4"><Feedback kind="error">{message}</Feedback></div>{/if}
  <Button
    variant="ghost"
    class="mt-6 w-full"
    onclick={signOut}
    disabled={pending || createOrganization.pending > 0}>Sign out</Button
  >
</AuthLayout>
