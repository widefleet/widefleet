<script lang="ts">
  import type { setAppDescription } from "#lib/catalog.remote";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import Check from "@lucide/svelte/icons/check";
  import Pencil from "@lucide/svelte/icons/pencil";
  import X from "@lucide/svelte/icons/x";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { tick } from "svelte";

  // A text of an app, such as its name, that people who manage the app edit in place.
  let {
    form,
    appId,
    search,
    value,
    label,
    maxlength,
    heading = false,
    empty = "",
  }: {
    /** The form that saves the text; the app's text forms share one shape. */
    form: typeof setAppDescription;
    appId: string;
    search: string;
    value: string;
    /** Names the text, as in "Edit name". */
    label: string;
    maxlength: number;
    /** Shows the text as the page's heading, which cannot be empty. */
    heading?: boolean;
    /** Offers to add a text that is missing. */
    empty?: string;
  } = $props();

  const name = $derived(label.toLowerCase());

  let editing = $state(false);

  let draft = $state("");

  let input = $state<HTMLInputElement | null>(null);

  let trigger = $state<HTMLButtonElement>();

  const changed = $derived(draft.trim() !== value);

  // A save in flight ends the edit, so the text cannot change or be discarded meanwhile.
  const saving = $derived(form.pending > 0);

  const start = async () => {
    draft = value;
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

{#snippet text()}
  <!-- The button covers the text, so choosing the text starts the edit, and the text keeps
       its own role: a heading reads as the name alone. -->
  <div class={`group relative flex max-w-full items-center gap-2 ${heading ? "" : "mt-2 text-sm"}`}>
    {#if heading}<h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">
        {value}
      </h1>{:else}<span
        class={`wrap-anywhere ${value ? "" : "text-muted-foreground group-hover:text-foreground"}`}
        >{value || empty}</span
      >{/if}
    <button
      bind:this={trigger}
      type="button"
      onclick={start}
      aria-label={`Edit ${name}`}
      class="text-muted-foreground shrink-0 rounded-sm opacity-0 group-hover:opacity-100 after:absolute after:inset-0 focus-visible:opacity-100 pointer-coarse:opacity-100"
      ><Pencil class={heading ? "size-4" : "size-3.5"} aria-hidden="true" /></button
    >
  </div>
{/snippet}

{#if editing}
  <!-- The page keeps its heading while the name is a field. -->
  {#if heading}<h1 class="sr-only">{value}</h1>{/if}
  <!-- The field takes the place of the text. Leaving it keeps unsaved text: only Save and
       Discard end an edit with changes. -->
  <form
    {...form.enhance(async ({ submit }) => {
      if (!changed || (await submit())) await close();
    })}
    class={`-ml-2.5 flex max-w-xl flex-wrap items-center gap-1 ${heading ? "-my-1" : "mt-0.5 -mb-1.5"}`}
    onfocusout={(event) => {
      if (
        !changed &&
        !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      )
        editing = false;
    }}
    onkeydown={(event) => {
      if (event.key === "Escape" && !saving) void close();
    }}
  >
    <OrganizationField field={form.fields.organizationId} />
    <input {...form.fields.appId.as("hidden", appId)} />
    <input {...form.fields.search.as("hidden", search)} />
    <Input
      bind:ref={input}
      {...form.fields.value.as("text", value)}
      aria-label={label}
      {maxlength}
      required={heading}
      readonly={saving}
      oninput={(event) => {
        draft = event.currentTarget.value;
      }}
      class={`min-w-0 flex-1 ${heading ? "h-10 text-2xl font-semibold tracking-tight md:text-2xl" : ""}`}
    />
    {#if changed}
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        aria-label={`Save ${name}`}
        title="Save"
        disabled={saving}><Check /></Button
      ><Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Discard changes"
        title="Discard"
        disabled={saving}
        onclick={close}><X /></Button
      >
    {/if}
    <div class="basis-full empty:hidden">
      <FormIssues issues={form.fields.allIssues()} />
    </div>
  </form>
{:else}
  {@render text()}
{/if}
