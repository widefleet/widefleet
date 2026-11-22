<script lang="ts">
  import FormIssues from "#shadcn/FormIssues.svelte";
  import AuthLayout from "@platform/ui/auth-layout";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "@platform/ui/button";
  import { resetClientContext } from "#lib/analytics-client";
  import { createOrganization, joinOrganization } from "#lib/organizations.remote";
  import { Badge } from "@platform/ui/badge";
  import { Switch } from "@platform/ui/switch";
  import BadgeCheck from "@lucide/svelte/icons/badge-check";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import { authClient } from "#lib/auth-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let message = $state("");

  let pending = $state(false);

  let creating = $state(false);

  const creationIssues = $derived(createOrganization.fields.allIssues());

  let allowDomainJoin = $state(true);

  const joining = $derived(
    data.joinable.some((organization) => joinOrganization.for(organization.id).pending > 0),
  );

  const busy = $derived(pending || joining || createOrganization.pending > 0);

  const describeMembers = (organization: PageData["joinable"][number]) => {
    const count = `${organization.memberCount} ${organization.memberCount === 1 ? "member" : "members"}`;
    const [first, ...rest] = organization.colleagues;

    if (!first) return count;

    const names = rest.length
      ? `${[first, ...rest].slice(0, -1).join(", ")} and ${rest.at(-1)}`
      : first;

    return `${count}, including ${names}`;
  };

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
    {data.organizations.length
      ? "Choose an organization"
      : data.joinable.length
        ? "Join your team"
        : data.canCreateOrganization
          ? "Create your organization"
          : "Choose an organization"}
  </h1>
  <p class="text-muted-foreground mt-2 text-sm">
    {data.organizations.length
      ? data.connecting
        ? "Choose the organization whose apps you want to connect."
        : "Choose where you want to work."
      : data.joinable.length
        ? `These organizations are open to everyone with a @${data.joinable[0]?.domain} address.`
        : data.canCreateOrganization
          ? "Give your workspace a name. You can invite your team later."
          : data.creationRestricted
            ? `Your company manages Widefleet organizations for ${data.creationRestricted}. Ask one of its administrators for access.`
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
  {#if data.joinable.length}
    <section class="mt-6" aria-labelledby="joinable-heading">
      {#if data.organizations.length}
        <h2 id="joinable-heading" class="text-muted-foreground text-xs font-medium">
          Open to @{data.joinable[0]?.domain}
        </h2>
      {:else}
        <h2 id="joinable-heading" class="sr-only">Organizations you can join</h2>
      {/if}
      <ul class="mt-2 space-y-2">
        {#each data.joinable as organization (organization.id)}
          {@const join = joinOrganization.for(organization.id)}
          <li>
            <form
              {...join}
              class="flex items-center justify-between gap-3 rounded-md border px-4 py-3"
            >
              <input {...join.fields.organizationId.as("hidden", organization.id)} />
              <input {...join.fields.next.as("hidden", data.next)} />
              <div class="min-w-0">
                <p class="flex items-center gap-2 text-sm font-medium">
                  <span class="truncate">{organization.name}</span>
                  {#if organization.verified}<Badge variant="secondary"
                      ><BadgeCheck data-icon="inline-start" />Verified</Badge
                    >{/if}
                </p>
                <p class="text-muted-foreground mt-1 text-xs">{describeMembers(organization)}</p>
                <FormIssues issues={join.fields.allIssues()} />
              </div>
              <Button type="submit" size="sm" disabled={busy}
                >{join.pending ? "Joining …" : "Join"}</Button
              >
            </form>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if data.canCreateOrganization || creationIssues?.length}
    {#if (data.organizations.length || data.joinable.length) && !creating && !creationIssues?.length}
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
            disabled={busy}
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
            disabled={busy}
          />
          <p class="text-muted-foreground text-xs">
            Up to 50 lowercase letters, numbers and hyphens. Used in your apps’ addresses.
          </p>
        </div>
        {#if data.joinDomain}
          <div class="flex items-center justify-between gap-4 border-t pt-4">
            <Label for="allow-domain-join" class="block text-sm leading-5 font-normal"
              ><span
                >Allow anyone with a <span class="font-medium">@{data.joinDomain}</span> address to join</span
              ></Label
            >
            <Switch
              id="allow-domain-join"
              name={createOrganization.fields.allowDomainJoin.as("checkbox").name}
              bind:checked={allowDomainJoin}
              disabled={busy}
            />
          </div>
        {/if}
        <Button type="submit" class="w-full" disabled={busy}
          >{createOrganization.pending
            ? "Preparing your organization …"
            : "Create organization"}</Button
        >
      </form>
    {/if}
  {/if}
  {#if message}<div class="mt-4"><Feedback kind="error">{message}</Feedback></div>{/if}
  <Button variant="ghost" class="mt-6 w-full" onclick={signOut} disabled={busy}>Sign out</Button>
</AuthLayout>
