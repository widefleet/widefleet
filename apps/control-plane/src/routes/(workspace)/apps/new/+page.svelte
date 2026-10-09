<script lang="ts">
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import { createApp, getApps } from "#lib/apps.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import type { PageData } from "./$types";

  let { data: route }: { data: PageData } = $props();

  const data = $derived(await getApps());
</script>

<svelte:head><title>Create app · Widefleet</title></svelte:head>
<div class="mx-auto max-w-xl">
  <a
    href="/"
    class="text-muted-foreground hover:text-foreground mb-8 inline-flex items-center gap-2 text-xs"
    ><ArrowLeft class="size-3.5" />All apps</a
  >
  <PageHeading
    title={route.parentId ? "Create preview" : "A new app"}
    description="Give your app a name and an address. Then publish its first version."
  />
  <form {...createApp} class="mt-8 space-y-6">
    <FormIssues issues={createApp.fields.allIssues()} />
    <div class="space-y-2">
      <Label for="displayName">App name</Label><Input
        id="displayName"
        {...createApp.fields.displayName.as("text")}
        placeholder="For example, Team Notes"
        required
        maxlength={120}
        class="h-10"
      />
      <p class="text-muted-foreground text-xs leading-5">
        Help others find your app in the workspace.
      </p>
    </div>
    <div class="space-y-2">
      <Label for="slug">URL slug</Label><Input
        id="slug"
        {...createApp.fields.slug.as("text")}
        placeholder="team-notes"
        required
        maxlength={48}
        pattern="[a-z]([a-z0-9\-]*[a-z0-9])?"
        aria-describedby="slug-help"
        class="h-10 font-mono text-sm"
        autocomplete="off"
        spellcheck="false"
      />
      <p id="slug-help" class="text-muted-foreground text-xs leading-5">
        Part of your app's address. Use lowercase letters, numbers and hyphens; start with a letter.
      </p>
    </div>
    <details open={Boolean(route.parentId)} class="rounded-lg border p-4">
      <summary class="flex items-center gap-2 text-sm font-medium"
        ><GitBranch class="text-muted-foreground size-4" />Create as preview<span
          class="text-muted-foreground ml-auto text-xs font-normal">Optional</span
        ></summary
      >
      <div class="mt-4 space-y-2">
        <Label for="parentId">Preview of an existing app</Label><NativeSelect
          id="parentId"
          {...createApp.fields.parentId.as("select", route.parentId)}
          class="w-full"
          ><option value="">Standalone app</option
          >{#each data.apps as app (app.id)}{#if app.state !== "deleting" && !app.parentId}<option
                value={app.id}>{app.displayName}</option
              >{/if}{/each}</NativeSelect
        >
        <p class="text-muted-foreground text-xs leading-5">
          A preview has its own URL and data. The original app stays unchanged.
        </p>
      </div>
    </details>
    <div class="flex items-center justify-between border-t pt-6">
      <Button href="/" variant="ghost">Cancel</Button><Button
        type="submit"
        disabled={createApp.pending > 0}
        >{createApp.pending ? "Creating app …" : "Create app"}<ArrowRight /></Button
      >
    </div>
  </form>
</div>
