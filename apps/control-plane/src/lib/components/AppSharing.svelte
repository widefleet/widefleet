<script lang="ts">
  import type { RemoteFormFields } from "$app/server";
  import { grantAppRole, revokeAppRole, transferAppOwnership } from "#lib/app-roles.remote";
  import { searchAccessGroups } from "#lib/app-access.remote";
  import type { getAppDetails } from "#lib/apps.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import Feedback from "./Feedback.svelte";

  let {
    data: details,
    search,
    initialSaved,
  }: {
    data: Awaited<ReturnType<typeof getAppDetails>>;
    search: string;
    initialSaved: boolean;
  } = $props();

  let saved = $derived(initialSaved);

  const appId = $derived(details.app.id);

  const data = $derived(details.roles);

  const candidates = $derived(details.candidates);

  const grant = $derived(grantAppRole.for(appId));

  const transfer = $derived(transferAppOwnership.for(appId));

  const directory = $derived(searchAccessGroups.for(appId));

  let selectedProvider = $state<string | undefined>();

  const provider = $derived(selectedProvider ?? data.provider);

  let revisions = $state<Record<string, number>>({});

  type RevisionFields = Pick<RemoteFormFields<{ revision: number }>, "revision" | "allIssues">;

  function draftRevision(key: string, fields: RevisionFields) {
    // Rejected native submissions retain the serialized hidden field value.
    return Number(
      revisions[key] ??
        (fields.allIssues()?.length ? fields.revision.value() : undefined) ??
        data.revision,
    );
  }

  function beginDraft(key: string, fields: RevisionFields) {
    revisions[key] ??= draftRevision(key, fields);
  }

  const labels = { user: "User", developer: "Developer", admin: "App admin", owner: "Owner" };

  const editable = $derived(data.inheritedFrom === null && data.actions.includes("roles"));

  function choose(person: { type: "user" | "group"; provider: string; subject: string }) {
    beginDraft("grant", grant.fields);
    grant.fields.type.set(person.type);
    selectedProvider = person.provider;
    grant.fields.subject.set(person.subject);
  }
</script>

<section id="access" aria-labelledby="roles-heading" class="max-w-3xl space-y-6">
  <h2 id="roles-heading" class="text-base font-semibold">Roles and ownership</h2>
  {#if saved}<Feedback kind="success">Role changes saved.</Feedback>{/if}
  <p class="text-muted-foreground text-sm leading-6">
    Every role includes app usage. Developers can deploy, read logs, manage workflows, restore
    versions and run database migrations. App admins also manage roles, network permissions, catalog
    visibility and deletion. Owners can transfer ownership.
  </p>
  {#if data.inheritedFrom}<p>
      Roles and ownership are inherited from the <a
        href={`/apps/${data.inheritedFrom}?tab=access&scope=management`}>original app</a
      >.
    </p>{/if}
  <ul class="divide-y rounded-xl border">
    {#each data.assignments as assignment (assignment.id)}
      <li class="flex flex-wrap items-start justify-between gap-4 p-4">
        <div>
          <strong>{labels[assignment.role]}</strong> · {assignment.principal.type === "group"
            ? "Group"
            : "Person"}
          <p><code class="text-xs break-all">{assignment.principal.subject}</code></p>
          <p class="text-muted-foreground text-xs break-all">{assignment.principal.provider}</p>
        </div>
        {#if editable && assignment.role !== "owner"}
          {@const revoke = revokeAppRole.for(assignment.id)}
          <form
            class="space-y-3"
            onfocusin={() => beginDraft(assignment.id, revoke.fields)}
            {...revoke.enhance(async ({ submit }) => {
              saved = false;
              saved = await submit();
              if (saved) delete revisions[assignment.id];
            })}
          >
            <input {...revoke.fields.appId.as("hidden", appId)} /><input
              {...revoke.fields.assignmentId.as("hidden", assignment.id)}
            />
            <input
              {...revoke.fields.revision.as("hidden", draftRevision(assignment.id, revoke.fields))}
            /><input {...revoke.fields.search.as("hidden", search)} />
            <FormIssues issues={revoke.fields.allIssues()} /><Button
              type="submit"
              variant="outline"
              disabled={revoke.pending > 0}>Revoke role</Button
            >
          </form>
        {/if}
      </li>
    {/each}
  </ul>
  {#if editable}
    <a
      href={`/apps/${appId}?${new URLSearchParams({ tab: "access", scope: "management", q: search })}`}
      data-sveltekit-reload
      class="text-muted-foreground text-xs hover:underline">Discard drafts and reload roles</a
    >
    <form method="GET" action="#access" class="space-y-3">
      <input type="hidden" name="tab" value="access" /><input
        type="hidden"
        name="scope"
        value="management"
      /><label class="grid gap-2 text-sm font-medium" for="member-search"
        >Find a member by name or email</label
      ><Input id="member-search" name="q" value={search} maxlength={200} required /><Button
        type="submit"
        variant="outline">Find member</Button
      >
    </form>
    {#if search && !candidates.length}<p>No members found.</p>{/if}
    <ul class="divide-y rounded-xl border">
      {#each candidates as person (`${person.principal.provider}:${person.principal.subject}`)}
        {@const memberKey = `${appId}:member:${person.principal.provider}:${person.principal.subject}`}
        {@const memberGrant = grantAppRole.for(memberKey)}
        <li class="flex flex-wrap items-start justify-between gap-4 p-4">
          <div>
            <strong>{person.name}</strong>
            <p>{person.email}</p>
          </div>
          <form
            class="space-y-3"
            onfocusin={() => beginDraft(`grant:${memberKey}`, memberGrant.fields)}
            {...memberGrant.enhance(async ({ submit }) => {
              saved = false;
              saved = await submit();
              if (saved) delete revisions[`grant:${memberKey}`];
            })}
          >
            <input {...memberGrant.fields.appId.as("hidden", appId)} /><input
              {...memberGrant.fields.revision.as(
                "hidden",
                draftRevision(`grant:${memberKey}`, memberGrant.fields),
              )}
            /><input {...memberGrant.fields.search.as("hidden", search)} />
            <input {...memberGrant.fields.type.as("hidden", "user")} /><input
              {...memberGrant.fields.provider.as("hidden", person.principal.provider)}
            /><input {...memberGrant.fields.subject.as("hidden", person.principal.subject)} />
            <label class="grid gap-2 text-sm font-medium"
              >Role for {person.name}<NativeSelect {...memberGrant.fields.role.as("select")}
                ><option value="user">User</option><option value="developer">Developer</option
                ><option value="admin">App admin</option></NativeSelect
              ></label
            >
            <FormIssues issues={memberGrant.fields.allIssues()} /><Button
              type="submit"
              disabled={memberGrant.pending > 0}>Grant role to {person.name}</Button
            >
          </form>
          {#if data.actions.includes("transfer")}
            {@const memberTransfer = transferAppOwnership.for(memberKey)}
            <details
              class="space-y-4 rounded-lg border p-4"
              onfocusin={() => beginDraft(`transfer:${memberKey}`, memberTransfer.fields)}
              open={Boolean(memberTransfer.fields.allIssues()?.length)}
            >
              <summary class="text-sm font-medium">Transfer ownership to {person.name}</summary>
              <form class="space-y-3" {...memberTransfer}>
                <input {...memberTransfer.fields.appId.as("hidden", appId)} /><input
                  {...memberTransfer.fields.revision.as(
                    "hidden",
                    draftRevision(`transfer:${memberKey}`, memberTransfer.fields),
                  )}
                /><input {...memberTransfer.fields.type.as("hidden", "user")} /><input
                  {...memberTransfer.fields.provider.as("hidden", person.principal.provider)}
                /><input
                  {...memberTransfer.fields.subject.as("hidden", person.principal.subject)}
                />
                <p>The previous owner loses the owner role when the transfer completes.</p>
                <FormIssues issues={memberTransfer.fields.allIssues()} /><Button
                  type="submit"
                  disabled={memberTransfer.pending > 0}>Confirm transfer to {person.name}</Button
                >
              </form>
            </details>
          {/if}
        </li>
      {/each}
    </ul>
    <details
      class="space-y-4 rounded-lg border p-4"
      open={Boolean(directory.fields.allIssues()?.length || directory.result)}
    >
      <summary class="text-sm font-medium">Search the company directory for groups</summary>
      <form class="space-y-3" {...directory}>
        <input {...directory.fields.appId.as("hidden", appId)} /><label
          class="grid gap-2 text-sm font-medium"
          for="group-search">Group name</label
        ><Input id="group-search" {...directory.fields.query.as("search")} required /><FormIssues
          issues={directory.fields.allIssues()}
        /><Button type="submit" variant="outline" disabled={directory.pending > 0}
          >Search groups</Button
        >
      </form>
      {#if directory.result}<ul class="divide-y rounded-xl border">
          {#each directory.result.groups as group (group.id)}<li
              class="flex flex-wrap items-start justify-between gap-4 p-4"
            >
              <div>
                <strong>{group.name}</strong>
                <p><code class="text-xs break-all">{group.id}</code></p>
              </div>
              <Button
                type="button"
                variant="outline"
                onclick={() =>
                  choose({ type: "group", provider: data.provider, subject: group.id })}
                >Select group</Button
              >
            </li>{/each}
        </ul>{/if}
    </details>
    <details
      class="space-y-4 rounded-lg border p-4"
      open={Boolean(grant.fields.subject.value() || grant.fields.allIssues()?.length)}
    >
      <summary class="text-sm font-medium">Assign a role by person or group ID</summary>
      <form
        class="space-y-3"
        onfocusin={() => beginDraft("grant", grant.fields)}
        {...grant.enhance(async ({ submit }) => {
          saved = false;
          saved = await submit();
          if (saved) delete revisions["grant"];
        })}
      >
        <input {...grant.fields.appId.as("hidden", appId)} /><input
          {...grant.fields.revision.as("hidden", draftRevision("grant", grant.fields))}
        /><input {...grant.fields.search.as("hidden", search)} /><input
          {...grant.fields.provider.as("hidden", provider)}
        />
        <label class="grid gap-2 text-sm font-medium" for="principal-type">Recipient</label
        ><NativeSelect
          id="principal-type"
          {...grant.fields.type.as("select")}
          onchange={() => {
            selectedProvider = undefined;
            grant.fields.subject.set("");
          }}
          ><option value="group">SSO group</option><option value="user">Person</option
          ></NativeSelect
        >
        <label class="grid gap-2 text-sm font-medium" for="principal-subject">Stable ID</label
        ><Input
          id="principal-subject"
          {...grant.fields.subject.as("text")}
          required
          maxlength={256}
        />
        <label class="grid gap-2 text-sm font-medium" for="app-role">Role</label><NativeSelect
          id="app-role"
          {...grant.fields.role.as("select")}
          ><option value="user">User</option><option value="developer">Developer</option><option
            value="admin">App admin</option
          ></NativeSelect
        >
        <FormIssues issues={grant.fields.allIssues()} /><Button
          type="submit"
          disabled={grant.pending > 0}>Grant role</Button
        >
        {#if grant.result?.saved}<p role="status">
            Role saved. App usage changes take effect when the gateway activates the rules.
          </p>{/if}
      </form>
    </details>
    {#if data.actions.includes("transfer")}
      <details
        class="space-y-4 rounded-lg border p-4"
        onfocusin={() => beginDraft("transfer", transfer.fields)}
        open={Boolean(transfer.fields.allIssues()?.length)}
      >
        <summary class="text-sm font-medium">Transfer ownership</summary>
        <p>
          The selected person or group becomes the owner immediately. The previous owner loses that
          role; other assignments remain.
        </p>
        <form class="space-y-3" {...transfer}>
          <input {...transfer.fields.appId.as("hidden", appId)} /><input
            {...transfer.fields.revision.as("hidden", draftRevision("transfer", transfer.fields))}
          /><label class="grid gap-2 text-sm font-medium"
            >New owner type<NativeSelect {...transfer.fields.type.as("select")}
              ><option value="group">SSO group</option><option value="user">Person</option
              ></NativeSelect
            ></label
          ><input {...transfer.fields.provider.as("hidden", data.provider)} /><label
            class="grid gap-2 text-sm font-medium"
            >New owner ID<Input
              {...transfer.fields.subject.as("text")}
              required
              maxlength={256}
            /></label
          >

          <FormIssues issues={transfer.fields.allIssues()} /><Button
            type="submit"
            disabled={transfer.pending > 0}>Transfer ownership</Button
          >
        </form>
      </details>
    {/if}
  {/if}
</section>
