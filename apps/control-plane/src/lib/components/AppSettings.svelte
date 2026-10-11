<script lang="ts">
  import { getAppDetails, removeApp } from "#lib/apps.remote";
  import { setCatalogListing } from "#lib/catalog.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import CopyValue from "./CopyValue.svelte";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  let { data, search }: { data: Awaited<ReturnType<typeof getAppDetails>>; search: string } =
    $props();

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
  {#if !app.parentId}<section id="catalog" class="rounded-xl border p-5 sm:p-6">
      <h2 class="text-base font-semibold">App catalog</h2>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        Make this app discoverable to everyone in the workspace. The app's access rules still apply.
      </p>
      {#if app.state === "active" && app.activeDeploymentId}
        <p class="my-4 text-xs">
          {app.catalogListed
            ? "This app is visible in the catalog to all signed-in members."
            : "This app is not listed in the catalog yet."}
        </p>
        {#if data.roles.actions.includes("catalog")}<form {...setCatalogListing} class="space-y-3">
            <input {...setCatalogListing.fields.appId.as("hidden", app.id)} />
            <input {...setCatalogListing.fields.search.as("hidden", search)} />
            <input
              {...setCatalogListing.fields.listed.as(
                "hidden",
                app.catalogListed ? "false" : "true",
              )}
            />
            <FormIssues issues={setCatalogListing.fields.allIssues()} />
            <Button type="submit" variant="outline" disabled={setCatalogListing.pending > 0}
              >{setCatalogListing.pending
                ? "Saving catalog visibility …"
                : app.catalogListed
                  ? "Remove from catalog"
                  : "Publish to catalog"}</Button
            >
          </form>{/if}
      {:else}<p class="text-muted-foreground mt-4 text-xs leading-6">
          You can publish this app to the catalog after its first successful deployment.
        </p>{/if}
      <a href="/catalog" class="text-primary mt-4 inline-block text-xs hover:underline"
        >Open app catalog</a
      >
    </section>{/if}
  {#if data.roles.actions.includes("delete")}<section
      class="rounded-xl border border-destructive/25 p-5 sm:p-6"
    >
      <h2 class="text-destructive flex items-center gap-2 text-sm font-semibold">
        <Trash2 class="size-4" />Remove app
      </h2>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        This app, all its previews and their published versions will be removed.
      </p>
      <p class="text-muted-foreground mt-2 text-xs leading-6">This action cannot be undone.</p>
      <details class="mt-5">
        <summary class="text-sm font-medium">Permanently delete app</summary>
        <form {...removeApp} class="mt-4 space-y-4">
          <input {...removeApp.fields.appId.as("hidden", app.id)} /><FormIssues
            issues={removeApp.fields.allIssues()}
          /><label class="flex items-start gap-3 text-sm leading-6"
            ><input
              {...removeApp.fields.confirmed.as("checkbox")}
              required
              class="accent-destructive mt-1 size-4 shrink-0"
            />I want to permanently delete this app and all its previews.</label
          ><Button type="submit" variant="destructive" disabled={removeApp.pending > 0}
            ><Trash2 />{removeApp.pending ? "Requesting deletion …" : "Delete app"}</Button
          >
        </form>
      </details>
    </section>{/if}
</div>
