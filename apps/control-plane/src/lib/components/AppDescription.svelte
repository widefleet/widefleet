<script lang="ts">
  import { setAppDescription } from "#lib/catalog.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import Check from "@lucide/svelte/icons/check";
  import Pencil from "@lucide/svelte/icons/pencil";
  import X from "@lucide/svelte/icons/x";
  import { appDescriptionLength } from "@platform/contracts";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { tick } from "svelte";

  // The sentence under an app's name. People who manage the app edit it in place.
  let {
    appId,
    description,
    search,
  }: { appId: string; description: string | null; search: string } = $props();

  const saved = $derived(description ?? "");

  let editing = $state(false);

  let draft = $state("");

  let input = $state<HTMLInputElement | null>(null);

  let trigger = $state<HTMLButtonElement>();

  const changed = $derived(draft.trim() !== saved);

  const start = async () => {
    draft = saved;
    editing = true;
    await tick();
    input?.select();
  };

  const close = async () => {
    editing = false;
    await tick();
    trigger?.focus();
  };
</script>

{#if editing}
  <!-- Leaving the field keeps unsaved text: only Save and Discard end an edit with changes. -->
  <form
    {...setAppDescription.enhance(async ({ submit }) => {
      if (!changed || (await submit())) await close();
    })}
    class="mt-0.5 -mb-1.5 -ml-2.5 flex max-w-xl flex-wrap items-center gap-1"
    onfocusout={(event) => {
      if (
        !changed &&
        !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      )
        editing = false;
    }}
    onkeydown={(event) => {
      if (event.key === "Escape") void close();
    }}
  >
    <OrganizationField field={setAppDescription.fields.organizationId} />
    <input {...setAppDescription.fields.appId.as("hidden", appId)} />
    <input {...setAppDescription.fields.search.as("hidden", search)} />
    <Input
      bind:ref={input}
      {...setAppDescription.fields.description.as("text", saved)}
      aria-label="Description"
      maxlength={appDescriptionLength}
      placeholder="What is this app for?"
      oninput={(event) => {
        draft = event.currentTarget.value;
      }}
      class="min-w-0 flex-1"
    />
    {#if changed}
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        aria-label="Save description"
        title="Save"
        disabled={setAppDescription.pending > 0}><Check /></Button
      ><Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Discard changes"
        title="Discard"
        onclick={close}><X /></Button
      >
    {/if}
    <div class="basis-full empty:hidden">
      <FormIssues issues={setAppDescription.fields.allIssues()} />
    </div>
  </form>
{:else}
  <button
    bind:this={trigger}
    type="button"
    onclick={start}
    class="group mt-2 flex max-w-full items-center gap-2 rounded-sm text-left text-sm"
  >
    <span
      class={`wrap-anywhere ${saved ? "" : "text-muted-foreground group-hover:text-foreground"}`}
      >{saved || "Add a description"}</span
    >
    <Pencil
      class="text-muted-foreground size-3.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100"
      aria-hidden="true"
    /><span class="sr-only">Edit description</span>
  </button>
{/if}
