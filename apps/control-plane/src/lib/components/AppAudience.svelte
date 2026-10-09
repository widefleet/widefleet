<script module lang="ts">
  export type AccessDraft = { appId: string; groups: string; revision: number };
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { changeAppAccess, getAppAccess, searchAccessGroups } from "#lib/app-access.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Textarea } from "#shadcn/components/ui/textarea/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import Feedback from "./Feedback.svelte";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Search from "@lucide/svelte/icons/search";

  let {
    appId,
    initialSaved = false,
    draft = $bindable(),
  }: { appId: string; initialSaved?: boolean; draft: AccessDraft | undefined } = $props();

  const access = $derived(getAppAccess({ appId }));

  const data = $derived(
    await access.catch((cause: unknown) => {
      if (access.error && access.error.status >= 500 && access.current) return access.current;
      throw cause;
    }),
  );

  const search = $derived(searchAccessGroups.for(appId));

  const editor = $derived(changeAppAccess.for(appId));

  const currentDraft = $derived(draft?.appId === appId ? draft : undefined);

  const status = {
    saved: "Saved · applies from the first deployment",
    pending: "Activation pending",
    active: "Active",
    failed: "Activation failed",
  };

  let refreshing = $state(false);

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;

    try {
      await access.refresh();
    } catch {
      // Keep the draft and last confirmed result; the query exposes the refresh error.
    } finally {
      refreshing = false;
    }
  };

  onMount(() => {
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        (data.state === "pending" || data.previews.some((preview) => preview.state === "pending"))
      )
        void refresh();
    }, 5000);

    return () => clearInterval(timer);
  });

  function editGroups(groups: string) {
    draft = { appId, groups, revision: currentDraft?.revision ?? data.revision };
  }

  function selectGroup(group: string) {
    const current = currentDraft?.groups ?? data.groups.join("\n");

    const groups = current
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    editGroups([...new Set([...groups, group])].join("\n"));
  }
</script>

<section id="app-access" aria-labelledby="audience-heading" class="max-w-3xl space-y-6">
  <div>
    <h2 id="audience-heading" class="text-base font-semibold">App access</h2>
    <p class="text-muted-foreground mt-2 text-sm leading-6">
      These rules protect the published app, including its files and API requests. Membership in any
      selected group grants access. Without group restrictions, anyone signed in through company SSO
      can use the app.
    </p>
  </div>
  <div class="bg-muted/40 flex items-start gap-3 rounded-lg border p-4 text-xs leading-6">
    <ShieldCheck class="text-muted-foreground mt-1 size-4 shrink-0" />
    <p>
      Group membership changes take effect after a new SSO sign-in. Permissions to manage this app
      are configured separately under Management access.
    </p>
  </div>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <Badge variant={data.state === "failed" ? "destructive" : "secondary"} role="status"
      >{status[data.state]}</Badge
    >
    <Button
      href={`/apps/${appId}?tab=access&scope=app`}
      variant="ghost"
      size="sm"
      data-sveltekit-reload
      onclick={(event) => {
        event.preventDefault();
        void refresh();
      }}
      aria-disabled={refreshing}
    >
      <RefreshCw class={refreshing ? "animate-spin motion-reduce:animate-none" : ""} />Refresh
      status
    </Button>
  </div>
  {#if access.error}<Feedback kind="error"
      >Could not refresh the status. Your changes are preserved. Check your connection and try
      again.</Feedback
    >{/if}
  {#if data.error}<Feedback kind="error">{data.error}</Feedback>{/if}
  {#if data.state === "pending" || data.state === "failed"}<Feedback
      >Activation has not been confirmed yet. Saved changes may already be in effect.</Feedback
    >{/if}
  {#if initialSaved}<Feedback kind="success"
      >Access rules saved. Check the status for activation progress.</Feedback
    >{/if}

  {#if data.inheritedFrom}
    <div class="rounded-xl border p-5">
      <p class="text-sm leading-6">
        This preview automatically inherits the original app's access rules. You cannot set separate
        rules.
      </p>
      <Button
        href={`/apps/${data.inheritedFrom}?tab=access&scope=app`}
        variant="outline"
        class="mt-4">Original app rules</Button
      >
    </div>
  {/if}

  {#if data.canManage}
    {#key appId}
      {@const groupsField = editor.fields.groups.as("text")}
      <form
        {...editor.enhance(async ({ submit }) => {
          const submittedDraft = currentDraft;
          if ((await submit()) && currentDraft === submittedDraft) draft = undefined;
        })}
        class="space-y-4 rounded-xl border p-5 sm:p-6"
      >
        <input {...editor.fields.appId.as("hidden", appId)} />
        <input {...editor.fields.revision.as("hidden", currentDraft?.revision ?? data.revision)} />
        <div class="space-y-2">
          <Label for="groups-app">Allowed groups for this app</Label>
          <Textarea
            id="groups-app"
            name={groupsField.name}
            aria-invalid={groupsField["aria-invalid"]}
            bind:value={() => currentDraft?.groups ?? data.groups.join("\n"), editGroups}
            disabled={editor.pending > 0}
            rows={4}
            aria-describedby="groups-help"
            class="font-mono text-sm"
          />
          <p id="groups-help" class="text-muted-foreground text-xs leading-6">
            One group ID per line. Leave blank to allow all signed-in users. All existing and new
            previews inherit these rules automatically.
          </p>
        </div>
        <FormIssues issues={editor.fields.allIssues()} />
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={editor.pending > 0}
            >{editor.pending ? "Saving …" : "Save app rules"}</Button
          >
          <a
            href={`/apps/${appId}?tab=access&scope=app`}
            data-sveltekit-reload
            class="text-muted-foreground text-xs hover:underline">Discard draft and reload rules</a
          >
        </div>
        {#if editor.result?.saved}<Feedback kind="success"
            >Rules saved. Activation is confirmed separately.</Feedback
          >{/if}
      </form>
    {/key}
    <details class="rounded-xl border p-5 sm:p-6">
      <summary class="text-sm font-medium">Search the company directory for groups</summary>
      <form {...search} class="mt-5 max-w-lg space-y-3">
        <input {...search.fields.appId.as("hidden", appId)} />
        <Label for="group-search">Group name</Label>
        <div class="flex gap-2">
          <Input
            id="group-search"
            {...search.fields.query.as("search")}
            required
            placeholder="Search groups …"
          />
          <Button type="submit" variant="outline" disabled={search.pending > 0}
            ><Search />{search.pending ? "Searching …" : "Search groups"}</Button
          >
        </div>
        <FormIssues issues={search.fields.allIssues()} />
      </form>
      {#if search.result}
        {#if search.result.groups.length === 0}<p class="text-muted-foreground mt-4 text-sm">
            No groups found.
          </p>{/if}
        <ul class="mt-4 divide-y">
          {#each search.result.groups as group (group.id)}<li
              class="flex flex-wrap items-center justify-between gap-3 py-4"
            >
              <div class="min-w-0">
                <p class="text-sm font-medium">{group.name}</p>
                <p class="text-muted-foreground mt-1 text-xs wrap-anywhere">
                  <code>{group.id}</code>
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={editor.pending > 0}
                onclick={() => selectGroup(group.id)}>Select group</Button
              >
            </li>{/each}
        </ul>
        <p class="text-muted-foreground mt-4 text-xs leading-6">
          Your selection takes effect after you choose Save app rules. You can also enter group IDs
          directly in the field.
        </p>
        {#if search.result.hasMore}<p class="text-muted-foreground mt-2 text-xs">
            More results are available. Refine your search.
          </p>{/if}
      {/if}
    </details>
  {:else}
    <p class="bg-muted/40 rounded-lg p-4 text-sm leading-6 wrap-anywhere">
      Allowed groups: {data.groups.length ? data.groups.join(", ") : "All signed-in users"}
    </p>
  {/if}

  {#if data.previews.length}
    <section class="border-t pt-6">
      <h3 class="text-sm font-semibold">Preview activation</h3>
      <ul class="mt-3 divide-y">
        {#each data.previews as preview (preview.appId)}<li class="py-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <a
                href={`/apps/${preview.appId}?tab=access&scope=app`}
                class="text-sm font-medium wrap-anywhere hover:underline">{preview.hostname}</a
              ><Badge variant="secondary">{status[preview.state]}</Badge>
            </div>
            {#if preview.error}<div class="mt-3">
                <Feedback kind="error">{preview.error}</Feedback>
              </div>{/if}
          </li>{/each}
      </ul>
    </section>
  {/if}
</section>
