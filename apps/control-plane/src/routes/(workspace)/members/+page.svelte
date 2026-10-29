<script lang="ts">
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import { invalidate } from "$app/navigation";
  import {
    getMembers,
    setMemberRole,
    inviteMember,
    cancelInvitation,
    deleteMember,
  } from "#lib/members.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import Search from "@lucide/svelte/icons/search";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Users from "@lucide/svelte/icons/users";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const data = $derived(await getMembers({ search: route.search, page: route.page }));

  let saved = $derived(route.saved);

  const pageLink = (page: number) =>
    `/members?${new URLSearchParams({ q: route.search, page: String(page) })}`;
</script>

<svelte:head><title>Members · Widefleet</title></svelte:head>
<PageHeading title="Members" description="The people in your workspace and their permissions." />
{#if route.invited}<div class="mt-5">
    <Feedback kind="success"
      >Invitation saved. If the email hasn't arrived, use Resend invitation.</Feedback
    >
  </div>{/if}
{#if data.emailEnabled}
  <details class="mt-6 rounded-lg border p-4">
    <summary class="text-sm font-medium">Invite a member</summary>
    <form {...inviteMember} class="mt-4 flex flex-wrap items-end gap-3">
      <OrganizationField field={inviteMember.fields.organizationId} />
      <div class="min-w-56 flex-1 space-y-2">
        <Label for="invite-email">Email</Label>
        <Input
          id="invite-email"
          {...inviteMember.fields.email.as("email")}
          required
          autocomplete="email"
        />
      </div>
      <div class="space-y-2">
        <Label for="invite-role">Role</Label>
        <NativeSelect id="invite-role" {...inviteMember.fields.role.as("select", "member")}>
          <option value="member">Member</option><option value="admin">Admin</option>
          {#if data.principal.role === "owner"}<option value="owner">Owner</option>{/if}
        </NativeSelect>
      </div>
      <Button type="submit" disabled={inviteMember.pending > 0}>Send invitation</Button>
      <FormIssues issues={inviteMember.fields.allIssues()} />
    </form>
  </details>
{/if}
<div class="mt-7 flex flex-wrap items-center justify-between gap-4 border-b pb-5">
  <form method="GET" role="search" class="flex w-full max-w-md gap-2">
    <div class="relative min-w-0 flex-1">
      <Search
        class="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-3.5"
      /><Input
        aria-label="Search by name or email"
        id="member-search"
        name="q"
        value={route.search}
        maxlength={200}
        type="search"
        placeholder="Name or email …"
        class="h-9 pl-8"
      />
    </div>
    <Button type="submit" variant="outline" class="h-9">Search</Button>{#if route.search}<Button
        href="/members"
        variant="ghost"
        class="h-9">Reset</Button
      >{/if}
  </form>
</div>
{#if saved}<div class="mt-5">
    <Feedback kind="success"
      >Role saved. The change also applies to CLI users who are already signed in.</Feedback
    >
  </div>{/if}
{#if data.members.length === 0}<EmptyState
    title="No members found"
    description="Try another name or email address."
    >{#snippet icon()}<Users />{/snippet}<Button href="/members" variant="outline"
      >All members</Button
    ></EmptyState
  >
{:else}
  <ul class="divide-y" aria-label="Members">
    {#each data.members as person (person.id)}
      {@const roleForm = setMemberRole.for(person.id)}
      {@const removeForm = deleteMember.for(person.id)}
      <li class="flex flex-wrap items-center justify-between gap-4 py-5">
        <div class="flex min-w-0 items-center gap-3">
          <span
            class="bg-muted grid size-9 shrink-0 place-items-center rounded-full text-xs font-medium"
            >{person.name.slice(0, 2).toUpperCase()}</span
          >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-medium">{person.name}</p>
              {#if person.userId === data.principal.id}<Badge
                  variant="secondary"
                  class="text-[10px]">You</Badge
                >{/if}
            </div>
            <p class="text-muted-foreground mt-1 truncate text-xs">{person.email}</p>
          </div>
        </div>
        {#if person.role !== "owner" || data.principal.role === "owner"}
          <form
            {...roleForm.enhance(async ({ submit }) => {
              saved = false;
              const submitted = await submit();
              if (submitted) await invalidate("workspace:principal");
              saved = submitted;
            })}
            aria-label={`Role for ${person.name}`}
            class="space-y-2"
          >
            <OrganizationField field={roleForm.fields.organizationId} />
            <input {...roleForm.fields.memberId.as("hidden", person.id)} /><input
              {...roleForm.fields.search.as("hidden", route.search)}
            /><input {...roleForm.fields.page.as("hidden", String(route.page))} /><FormIssues
              issues={roleForm.fields.allIssues()}
            />
            <div class="flex items-center gap-2">
              <label class="sr-only" for={`role-${person.id}`}>Role</label><NativeSelect
                id={`role-${person.id}`}
                {...roleForm.fields.role.as("select", person.role)}
                disabled={roleForm.pending > 0}
                class="w-32"
                ><option value="member">Member</option><option value="admin">Admin</option
                >{#if data.principal.role === "owner"}<option value="owner">Owner</option
                  >{/if}</NativeSelect
              ><Button type="submit" variant="outline" size="sm" disabled={roleForm.pending > 0}
                >{roleForm.pending ? "Saving …" : "Save role"}</Button
              >
            </div>
          </form>
          <details class="text-xs">
            <summary class="text-muted-foreground cursor-pointer">Remove member</summary>
            <form {...removeForm} class="mt-3 space-y-3">
              <OrganizationField field={removeForm.fields.organizationId} />
              <input {...removeForm.fields.memberId.as("hidden", person.id)} />
              <p>Remove {person.name} from this organization?</p>
              <FormIssues issues={removeForm.fields.allIssues()} />
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={removeForm.pending > 0}>Confirm removal</Button
              >
            </form>
          </details>
        {:else}<Badge variant="outline">Owner</Badge>{/if}
      </li>
    {/each}
  </ul>
{/if}
<nav
  class="text-muted-foreground flex items-center justify-between border-t pt-4 text-xs"
  aria-label="Member pages"
>
  <span>Page {route.page}</span>
  <div class="flex gap-2">
    {#if route.page > 1}<Button href={pageLink(route.page - 1)} variant="outline" size="sm"
        ><ArrowLeft />Back</Button
      >{/if}{#if data.hasNext}<Button href={pageLink(route.page + 1)} variant="outline" size="sm"
        >Continue<ArrowRight /></Button
      >{/if}
  </div>
</nav>
{#if data.invitations.some((entry) => entry.status === "pending")}
  <section class="mt-8" aria-label="Pending invitations">
    <h2 class="text-sm font-medium">Pending invitations</h2>
    <ul class="mt-3 divide-y">
      {#each data.invitations.filter((entry) => entry.status === "pending") as entry (entry.id)}
        <li class="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <p class="text-sm">{entry.email}</p>
            <p class="text-muted-foreground mt-1 text-xs">
              {entry.role} · Expires {new Date(entry.expiresAt).toLocaleDateString()}
            </p>
          </div>
          {#if entry.role !== "owner" || data.principal.role === "owner"}
            {@const resendForm = inviteMember.for(entry.id)}
            {@const cancelForm = cancelInvitation.for(entry.id)}
            {#if data.emailEnabled}
              <form {...resendForm}>
                <OrganizationField field={resendForm.fields.organizationId} />
                <input {...resendForm.fields.email.as("hidden", entry.email)} />
                <input {...resendForm.fields.role.as("hidden", entry.role)} />
                <input {...resendForm.fields.resend.as("hidden", "true")} />
                <FormIssues issues={resendForm.fields.allIssues()} />
                <Button type="submit" variant="outline" size="sm" disabled={resendForm.pending > 0}
                  >Resend invitation</Button
                >
              </form>
            {/if}
            <form {...cancelForm}>
              <OrganizationField field={cancelForm.fields.organizationId} />
              <input {...cancelForm.fields.invitationId.as("hidden", entry.id)} />
              <FormIssues issues={cancelForm.fields.allIssues()} />
              <Button type="submit" variant="outline" size="sm" disabled={cancelForm.pending > 0}
                >Revoke invitation</Button
              >
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
<details class="bg-muted/30 mt-10 rounded-lg border p-4">
  <summary class="text-sm font-medium">Understanding membership and roles</summary>
  <div class="text-muted-foreground mt-4 space-y-3 text-xs leading-6">
    <p>
      {#if data.emailEnabled}Invite people by email. They join after verifying their email address
        and accepting the invitation.
      {:else}New members appear after their first workspace sign-in with the installation's company
        account.{/if}
      Signing in to a published app alone does not create a workspace membership.
    </p>
    <dl class="grid gap-x-5 gap-y-2 sm:grid-cols-[80px_1fr]">
      <dt class="text-foreground font-medium">Member</dt>
      <dd>Create apps and manage apps they own or have access to.</dd>
      <dt class="text-foreground font-medium">Admin</dt>
      <dd>Also manage all apps, members and organization settings.</dd>
      <dt class="text-foreground font-medium">Owner</dt>
      <dd>Have all admin permissions and can appoint additional owners.</dd>
    </dl>
  </div>
</details>
