<script lang="ts">
  import FormIssues from "#shadcn/FormIssues.svelte";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { resetClientContext } from "#lib/analytics-client";
  import { selectOrganization, createOrganization } from "#lib/organizations.remote";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
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
      ? "Choose where you want to work."
      : data.canCreateOrganization
        ? "Give your workspace a name. You can invite your team later."
        : "Your account has no available organizations. Ask your administrator to grant access."}
  </p>
  <div class="mt-6 space-y-2">
    {#each data.organizations as organization (organization.id)}
      {#if organization.ssoRequired}
        <Button
          href={`/sign-in?${new URLSearchParams({ organization: organization.slug, next: data.next })}`}
          variant="outline"
          class="h-auto w-full justify-between px-4 py-3"
        >
          <span class="truncate">{organization.name}</span><span
            class="text-muted-foreground text-xs">Company SSO</span
          >
        </Button>
      {:else}
        {@const selection = selectOrganization.for(organization.id)}
        <form
          {...selection.enhance(async ({ submit }) => {
            if (pending) return;
            pending = true;
            message = "";
            try {
              await submit();
              // A full navigation drops cached queries and forms from the previous organization.
              if (selection.result?.selected) window.location.assign(selection.result.next);
            } catch {
              message = "Could not select this organization. Refresh the page and try again.";
            } finally {
              pending = false;
            }
          })}
        >
          <input {...selection.fields.organizationId.as("hidden", organization.id)} />
          <input {...selection.fields.next.as("hidden", data.next)} />
          <Button
            type="submit"
            variant="outline"
            class="h-auto w-full justify-between px-4 py-3"
            disabled={pending || createOrganization.pending > 0}
          >
            <span class="truncate">{organization.name}</span>
            <span class="text-muted-foreground text-xs capitalize">{organization.role}</span>
          </Button>
        </form>
      {/if}
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
