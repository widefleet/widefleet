<script module lang="ts">
  export type AccessDraft = { appId: string; allAuthenticated: boolean; revision: number };
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { changeAppAccess, getAppAccess } from "#lib/app-access.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import Feedback from "./Feedback.svelte";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

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

  function editAudience(allAuthenticated: boolean) {
    draft = { appId, allAuthenticated, revision: currentDraft?.revision ?? data.revision };
  }
</script>

<section id="app-access" aria-labelledby="audience-heading" class="max-w-3xl space-y-6">
  <div>
    <h2 id="audience-heading" class="text-base font-semibold">App access</h2>
    <p class="text-muted-foreground mt-2 text-sm leading-6">
      These rules protect the published app, including its files and API requests. People and SSO
      groups with an app role can use it. You can also explicitly allow everyone signed in through
      company SSO.
    </p>
  </div>
  <div class="bg-muted/40 flex items-start gap-3 rounded-lg border p-4 text-xs leading-6">
    <ShieldCheck class="text-muted-foreground mt-1 size-4 shrink-0" />
    <p>
      All app roles include access to the published app. Workspace administration alone does not
      grant app usage. Group membership changes take effect after a new SSO sign-in.
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
      <form
        {...editor.enhance(async ({ submit }) => {
          const submittedDraft = currentDraft;
          if ((await submit()) && currentDraft === submittedDraft) draft = undefined;
        })}
        class="space-y-4 rounded-xl border p-5 sm:p-6"
      >
        <input {...editor.fields.appId.as("hidden", appId)} />
        <input {...editor.fields.revision.as("hidden", currentDraft?.revision ?? data.revision)} />
        <label class="flex items-start gap-3 text-sm leading-6">
          <input
            {...editor.fields.allAuthenticated.as("checkbox")}
            type="checkbox"
            bind:checked={
              () => currentDraft?.allAuthenticated ?? data.allAuthenticated, editAudience
            }
            disabled={editor.pending > 0}
            aria-describedby="audience-help"
            class="accent-primary mt-1 size-4 shrink-0"
          />
          Allow everyone signed in through company SSO
        </label>
        <p id="audience-help" class="text-muted-foreground text-xs leading-6">
          When disabled, access requires an app role assigned to the person or one of their SSO
          groups. All previews inherit this setting. An empty list never grants access to everyone.
        </p>
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
  {:else}
    <p class="bg-muted/40 rounded-lg p-4 text-sm leading-6">
      {data.allAuthenticated
        ? "Everyone signed in through company SSO can use this app."
        : "App usage requires an assigned role, directly or through an SSO group."}
    </p>
  {/if}
  <p class="text-muted-foreground text-xs leading-6">
    The saved rules include {data.users.length} people and {data.groups.length} SSO groups.
    <a
      href={`/apps/${data.inheritedFrom ?? appId}?tab=access&scope=management`}
      class="text-primary underline underline-offset-4">Manage roles and ownership</a
    >.
  </p>

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
