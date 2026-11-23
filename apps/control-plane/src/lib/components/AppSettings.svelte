<script lang="ts">
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import { getAppDetails, removeApp } from "#lib/apps.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "@platform/ui/button";
  import CopyValue from "./CopyValue.svelte";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  let { data }: { data: Awaited<ReturnType<typeof getAppDetails>> } = $props();

  const app = $derived(data.app);
</script>

<div class="max-w-2xl space-y-10">
  <section>
    <h2 class="text-base font-semibold">App identity</h2>
    <p class="text-muted-foreground mt-2 mb-5 text-sm">
      Use this ID to identify your app in the CLI and API.
    </p>
    <CopyValue value={app.id} label="Copy app ID" />
  </section>
  <section class="rounded-xl border border-destructive/25 p-5 sm:p-6">
    <h2 class="text-destructive flex items-center gap-2 text-sm font-semibold">
      <Trash2 class="size-4" />Remove app
    </h2>
    <p class="text-muted-foreground mt-2 text-sm leading-6">
      This app, all its previews and their published versions will be removed.
    </p>
    {#if data.source.supported && data.source.branch}
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        {app.parentId
          ? "Its source branch remains in the main app’s Git repository."
          : "Any associated Widefleet Git repository and its branches will also be permanently deleted."}
      </p>
    {/if}
    <p class="text-muted-foreground mt-2 text-xs leading-6">This action cannot be undone.</p>
    <details class="mt-5">
      <summary class="text-sm font-medium">Permanently delete app</summary>
      <form {...removeApp} class="mt-4 space-y-4">
        <OrganizationField field={removeApp.fields.organizationId} />
        <input {...removeApp.fields.appId.as("hidden", app.id)} /><FormIssues
          issues={removeApp.fields.allIssues()}
        /><label class="flex items-start gap-3 text-sm leading-6"
          ><input
            {...removeApp.fields.confirmed.as("checkbox")}
            required
            class="accent-destructive mt-1 size-4 shrink-0"
          />I want to permanently delete this app and all its previews{!app.parentId &&
          data.source.supported
            ? ", including its Widefleet Git repository"
            : ""}.</label
        ><Button type="submit" variant="destructive" disabled={removeApp.pending > 0}
          ><Trash2 />{removeApp.pending ? "Requesting deletion …" : "Delete app"}</Button
        >
      </form>
    </details>
  </section>
</div>
