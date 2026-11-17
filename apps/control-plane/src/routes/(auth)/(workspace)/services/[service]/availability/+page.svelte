<script lang="ts">
  import {
    setServiceAccess,
    changeServiceUserAccess,
    getServiceUserAccess,
  } from "#lib/services.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "@platform/ui/button";
  import { Label } from "@platform/ui/label";
  import { NativeSelect } from "@platform/ui/native-select";
  import { Input } from "@platform/ui/input";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const access = $derived(await getServiceUserAccess({ appId: data.service.appId }));
</script>

<svelte:head><title>{data.service.displayName} availability · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-8">
  <a
    class="text-muted-foreground block text-sm underline underline-offset-4"
    href={`/services/${data.service.appId}`}>Back to {data.service.displayName}</a
  >
  <PageHeading
    title="API availability"
    description={`Choose who can connect apps and use ${data.service.displayName} through MCP.`}
  />
  {#if data.saved}<Feedback>Availability saved.</Feedback>{/if}
  <form {...setServiceAccess} class="space-y-6">
    <OrganizationField field={setServiceAccess.fields.organizationId} />
    <input {...setServiceAccess.fields.appId.as("hidden", data.service.appId)} />
    <div class="space-y-2">
      <Label for="availability">Who can connect this API?</Label>
      <NativeSelect
        id="availability"
        {...setServiceAccess.fields.accessMode.as("select", access.mode)}
        class="w-full"
      >
        <option value="approval_required">Administrator approval required</option>
        <option value="organization">Everyone in this organization</option>
      </NativeSelect>
    </div>
    <p class="text-muted-foreground text-sm leading-6">
      Members can only connect apps they manage. This setting applies to all entrypoints of this
      API. Existing app connections are kept when you change availability. Organization-wide
      availability also allows members to use this API through MCP.
    </p>
    <FormIssues issues={setServiceAccess.fields.allIssues()} />
    <div class="flex flex-wrap gap-3">
      <Button type="submit" disabled={setServiceAccess.pending > 0}>Save availability</Button>
      <Button variant="ghost" href={`/services/${data.service.appId}`}>Cancel</Button>
    </div>
  </form>
  <section class="space-y-5 border-t pt-6">
    <div class="space-y-2">
      <h2 class="text-lg font-medium">Users and groups</h2>
      <p class="text-muted-foreground text-sm leading-6">
        Grant access to individual entrypoints when administrator approval is required. Use the
        identity provider's exact user and group IDs.
      </p>
    </div>
    <p class="text-muted-foreground text-xs">
      Service permissions: {access.state}. Saved revision {access.revision}; active revision {access.appliedRevision ??
        "none"}.
    </p>
    {#if access.error}<Feedback kind="error">{access.error}</Feedback>{/if}
    {#each access.grants as grant (grant.entrypoint)}
      <div class="space-y-2">
        <h3 class="font-mono text-sm font-medium">{grant.entrypoint}</h3>
        {#each [...grant.users.map( (user) => ({ kind: "user" as const, issuer: user.issuer, subject: user.subject, group: "", label: `${user.subject} (${user.issuer})` }) ), ...grant.groups.map( (group) => ({ kind: "group" as const, issuer: "", subject: "", group, label: group }) )] as recipient (recipient.label)}
          {@const remove = changeServiceUserAccess.for(
            `${access.revision}-${grant.entrypoint}-${recipient.kind}-${recipient.label}`,
          )}
          <form {...remove} class="flex flex-wrap items-center justify-between gap-3 border-b py-2">
            <OrganizationField field={remove.fields.organizationId} />
            <input {...remove.fields.appId.as("hidden", data.service.appId)} /><input
              {...remove.fields.revision.as("hidden", access.revision)}
            /><input {...remove.fields.entrypoint.as("hidden", grant.entrypoint)} /><input
              {...remove.fields.kind.as("hidden", recipient.kind)}
            /><input {...remove.fields.action.as("hidden", "remove")} /><input
              {...remove.fields.issuer.as("hidden", recipient.issuer)}
            /><input {...remove.fields.subject.as("hidden", recipient.subject)} /><input
              {...remove.fields.group.as("hidden", recipient.group)}
            />
            <p class="min-w-0 flex-1 text-sm break-all">
              {recipient.kind === "group" ? "Group: " : "User: "}{recipient.label}
            </p>
            <Button type="submit" variant="ghost" size="sm" disabled={remove.pending > 0}
              >Remove</Button
            ><FormIssues issues={remove.fields.allIssues()} />
          </form>
        {/each}
      </div>
    {:else}<p class="text-muted-foreground text-sm">
        No individual users or groups have been granted access.
      </p>{/each}
    {#each ["user", "group"] as kind (kind)}
      {@const add = changeServiceUserAccess.for(`${kind}-${access.revision}`)}
      <details class="rounded-lg border p-4">
        <summary class="cursor-pointer text-sm font-medium">Add {kind}</summary>
        <form {...add} class="mt-4 space-y-4">
          <OrganizationField field={add.fields.organizationId} /><input
            {...add.fields.appId.as("hidden", data.service.appId)}
          /><input {...add.fields.revision.as("hidden", access.revision)} /><input
            {...add.fields.kind.as("hidden", kind)}
          /><input {...add.fields.action.as("hidden", "add")} />
          <div class="space-y-2">
            <Label for={`entrypoint-${kind}`}>Entrypoint</Label><NativeSelect
              id={`entrypoint-${kind}`}
              {...add.fields.entrypoint.as("select", data.service.entrypoints[0] ?? "")}
              class="w-full"
              >{#each data.service.entrypoints as entrypoint (entrypoint)}<option value={entrypoint}
                  >{entrypoint}</option
                >{/each}</NativeSelect
            >
          </div>
          {#if kind === "user"}<div class="space-y-2">
              <Label for="identity-issuer">Identity provider URL</Label><Input
                id="identity-issuer"
                {...add.fields.issuer.as("url", data.identityIssuer)}
                required
              />
            </div>
            <div class="space-y-2">
              <Label for="identity-subject">User ID</Label><Input
                id="identity-subject"
                {...add.fields.subject.as("text")}
                required
              />
            </div>
          {:else}<div class="space-y-2">
              <Label for="identity-group">Company group ID</Label><Input
                id="identity-group"
                {...add.fields.group.as("text")}
                required
              />
            </div>{/if}
          <FormIssues issues={add.fields.allIssues()} /><Button
            type="submit"
            disabled={add.pending > 0}>Grant access</Button
          >
        </form>
      </details>
    {/each}
  </section>
</div>
