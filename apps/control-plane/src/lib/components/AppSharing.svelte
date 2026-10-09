<script lang="ts">
  import { getAppDetails, grantAccess, revokeAccess } from "#lib/apps.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import UserPlus from "@lucide/svelte/icons/user-plus";
  import Search from "@lucide/svelte/icons/search";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import Feedback from "./Feedback.svelte";

  let {
    data,
    search,
    initialSaved,
  }: { data: Awaited<ReturnType<typeof getAppDetails>>; search: string; initialSaved: boolean } =
    $props();

  let saved = $derived(initialSaved);
</script>

<section id="access" aria-labelledby="access-heading" class="space-y-6">
  <div>
    <h2 id="access-heading" class="text-base font-semibold">Manage access</h2>
    <p class="text-muted-foreground mt-2 max-w-2xl text-sm leading-6">
      Members with access can deploy this app, restore previous versions and delete the app. Owners
      and admins can change access permissions.
    </p>
  </div>
  <div class="bg-muted/40 flex items-start gap-3 rounded-lg border p-4 text-xs leading-5">
    <ShieldCheck class="text-muted-foreground mt-0.5 size-4 shrink-0" />
    <p>
      Manage <strong class="font-medium">management access</strong> here. Access to the published
      app is controlled by its
      <a href={`/apps/${data.app.id}?tab=access&scope=app`} class="underline underline-offset-4"
        >app usage rules</a
      >. Workspace owners and admins have access to all apps.
    </p>
  </div>
  {#if saved}<Feedback kind="success">App access saved.</Feedback>{/if}
  <ul class="divide-y rounded-xl border" aria-label="Members with access">
    {#if data.access.owner}<li class="flex items-center justify-between gap-4 p-4">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{data.access.owner.name}</p>
          <p class="text-muted-foreground mt-1 truncate text-xs">{data.access.owner.email}</p>
        </div>
        <Badge variant="secondary">Owner</Badge>
      </li>{/if}
    {#each data.access.grants as person (person.userId)}
      {@const revoke = revokeAccess.for(`${data.app.id}:${person.userId}`)}
      <li class="flex flex-wrap items-center justify-between gap-3 p-4">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{person.name}</p>
          <p class="text-muted-foreground mt-1 truncate text-xs">{person.email}</p>
        </div>
        {#if data.access.canManage}<form
            {...revoke.enhance(async ({ submit }) => {
              saved = false;
              saved = await submit();
            })}
            class="space-y-2"
          >
            <input {...revoke.fields.appId.as("hidden", data.app.id)} /><input
              {...revoke.fields.search.as("hidden", search)}
            /><input {...revoke.fields.userId.as("hidden", person.userId)} /><FormIssues
              issues={revoke.fields.allIssues()}
            /><Button type="submit" variant="outline" size="sm" disabled={revoke.pending > 0}
              >{revoke.pending ? "Revoking access …" : "Revoke access"}</Button
            >
          </form>{/if}
      </li>
    {/each}
    {#if data.access.grants.length === 0}<li class="text-muted-foreground p-4 text-xs">
        No additional members have access yet.
      </li>{/if}
  </ul>
  {#if data.access.canManage}
    <div class="border-t pt-6">
      <h3 class="mb-4 flex items-center gap-2 text-sm font-medium">
        <UserPlus class="size-4" />Add member
      </h3>
      <form method="GET" action="#access" class="max-w-lg space-y-2">
        <input type="hidden" name="tab" value="access" /><input
          type="hidden"
          name="scope"
          value="management"
        /><Label for="access-search">Find a member by name or email</Label>
        <div class="flex gap-2">
          <Input
            id="access-search"
            type="search"
            name="q"
            value={search}
            maxlength={200}
            required
            placeholder="Name or email …"
          /><Button type="submit" variant="outline"
            ><Search /><span class="sr-only sm:not-sr-only">Find member</span></Button
          >
        </div>
      </form>
    </div>
    {#if search && data.access.candidates.length === 0}<p class="text-muted-foreground text-sm">
        No additional members found. Members with access are listed above.
      </p>{/if}
    {#if data.access.candidates.length > 0}<ul
        class="divide-y rounded-xl border"
        aria-label="Search results"
      >
        {#each data.access.candidates as person (person.id)}
          {@const grant = grantAccess.for(`${data.app.id}:${person.userId}`)}
          <li class="flex flex-wrap items-center justify-between gap-3 p-4">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{person.name}</p>
              <p class="text-muted-foreground mt-1 truncate text-xs">{person.email}</p>
            </div>
            <form
              {...grant.enhance(async ({ submit }) => {
                saved = false;
                saved = await submit();
              })}
              class="space-y-2"
            >
              <input {...grant.fields.appId.as("hidden", data.app.id)} /><input
                {...grant.fields.search.as("hidden", search)}
              /><input {...grant.fields.userId.as("hidden", person.userId)} /><FormIssues
                issues={grant.fields.allIssues()}
              /><Button type="submit" size="sm" disabled={grant.pending > 0}
                >{grant.pending ? "Granting access …" : "Grant access"}</Button
              >
            </form>
          </li>
        {/each}
      </ul>{/if}
    {#if data.access.hasMore}<p class="text-muted-foreground text-xs">
        More results are available. Refine your search.
      </p>{/if}
  {/if}
</section>
