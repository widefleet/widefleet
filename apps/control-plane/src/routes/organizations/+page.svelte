<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import AuthLayout from "#shadcn/components/AuthLayout.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { selectOrganization, createOrganization } from "#lib/organizations.remote";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { authClient } from "#lib/auth-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let message = $state("");

  let pending = $state(false);

  let creating = $state(false);

  let name = $state("");

  let slug = $state("");

  const create = async (event: SubmitEvent) => {
    event.preventDefault();

    if (pending) return;
    pending = true;
    message = "";

    try {
      await createOrganization({ name, slug });
      window.location.assign(data.next === "/" ? "/welcome" : data.next);
    } catch (cause) {
      message = isHttpError(cause)
        ? cause.body.message
        : cause instanceof Error
          ? cause.message
          : "Could not create your organization. Try again.";
    } finally {
      pending = false;
    }
  };

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
            disabled={pending}
          >
            <span class="truncate">{organization.name}</span>
            <span class="text-muted-foreground text-xs capitalize">{organization.role}</span>
          </Button>
        </form>
      {/if}
    {/each}
  </div>
  {#if data.canCreateOrganization}
    {#if data.organizations.length && !creating}
      <Button variant="outline" class="mt-4 w-full" onclick={() => (creating = true)}
        >Set up your own organization</Button
      >
    {:else}
      <form onsubmit={create} class="mt-6 space-y-4">
        <div class="space-y-2">
          <Label for="organization-name">Organization name</Label><Input
            id="organization-name"
            bind:value={name}
            required
            maxlength={200}
            autocomplete="organization"
            disabled={pending}
          />
        </div>
        <div class="space-y-2">
          <Label for="organization-slug">Organization URL name</Label><Input
            id="organization-slug"
            bind:value={slug}
            required
            maxlength={61}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            placeholder="my-team"
            disabled={pending}
          />
          <p class="text-muted-foreground text-xs">
            Lowercase letters, numbers and hyphens. Used in your apps’ addresses.
          </p>
        </div>
        <Button type="submit" class="w-full" disabled={pending}
          >{pending ? "Preparing your organization …" : "Create organization"}</Button
        >
      </form>
    {/if}
  {/if}
  {#if message}<div class="mt-4"><Feedback kind="error">{message}</Feedback></div>{/if}
  <Button variant="ghost" class="mt-6 w-full" onclick={signOut} disabled={pending}>Sign out</Button>
</AuthLayout>
