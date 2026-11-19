<script lang="ts">
  import AppWindow from "@lucide/svelte/icons/app-window";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { embeddingOrigin, maxEmbeddingOrigins, type settingsView } from "@platform/contracts";
  import type { z } from "zod";
  import { SettingsWriter, ssoDraft, ssoInput } from "#lib/sso-setup.svelte";
  import { Button } from "@platform/ui/button";
  import * as Dialog from "@platform/ui/dialog";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import EmptyState from "../EmptyState.svelte";
  import Feedback from "../Feedback.svelte";
  import RestartDialog from "./RestartDialog.svelte";

  let {
    view,
    organizationId,
    readonly,
  }: {
    view: z.infer<typeof settingsView>;
    organizationId: string;
    readonly: boolean;
  } = $props();

  const origins = $derived(view.settings.embeddingOrigins);

  let adding = $state(false);

  let input = $state("");

  let inputError = $state("");

  let removing = $state<string | null>(null);

  const writer = new SettingsWriter(
    () => organizationId,
    () => {},
  );

  const save = async (next: string[]) => {
    await writer.save(() =>
      ssoInput({ ...ssoDraft(view, organizationId), embeddingOrigins: next }, view),
    );

    return !writer.error;
  };

  const startAdding = () => {
    input = "";
    inputError = "";
    writer.error = "";
    adding = true;
  };

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = embeddingOrigin.safeParse(input);

    if (!parsed.success) {
      inputError = parsed.error.issues[0]?.message ?? "Enter a valid origin.";

      return;
    }

    if (origins.includes(parsed.data)) {
      inputError = `${parsed.data} is already allowed.`;

      return;
    }

    inputError = "";

    if (await save([...origins, parsed.data])) adding = false;
  };

  const remove = async (origin: string) => {
    removing = origin;
    await save(origins.filter((entry) => entry !== origin));
    removing = null;
  };
</script>

<section class="rounded-xl border" aria-labelledby="embedding-title">
  <div class="flex flex-wrap items-start justify-between gap-4 p-6">
    <div class="max-w-md">
      <h2 id="embedding-title" class="text-base font-semibold">Embedded apps</h2>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        Pages on these hosts can show your apps, such as a Microsoft Teams tab. Members are signed in
        with the Microsoft account they already use there.
      </p>
    </div>
    <Button
      variant="outline"
      size="sm"
      disabled={readonly || writer.busy || origins.length >= maxEmbeddingOrigins}
      onclick={startAdding}>Add host</Button
    >
  </div>
  {#if writer.error && !adding}<div class="px-6 pb-4">
      <Feedback kind="error">{writer.error}</Feedback>
    </div>{/if}
  {#if origins.length === 0}
    <div class="border-t">
      <EmptyState
        title="No embedding hosts"
        description="Add a host to show your apps inside Microsoft Teams or another portal."
        >{#snippet icon()}<AppWindow />{/snippet}</EmptyState
      >
    </div>
  {:else}
    <ul class="divide-y border-t" aria-label="Embedding hosts">
      {#each origins as origin (origin)}
        <li class="flex min-h-8 items-center gap-3 px-6 py-3.5">
          <p class="min-w-0 flex-1 truncate font-mono text-xs leading-5">{origin}</p>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${origin}`}
            title={`Remove ${origin}`}
            disabled={readonly || writer.busy}
            onclick={() => remove(origin)}><Trash /></Button
          >
          {#if removing === origin}<span class="sr-only" role="status">Removing {origin}</span
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Dialog.Root
  open={adding}
  onOpenChange={(next) => {
    if (!next && !writer.busy) adding = false;
  }}
>
  <Dialog.Content
    class="sm:max-w-lg"
    showCloseButton={!writer.busy}
    onInteractOutside={(event) => {
      if (writer.busy) event.preventDefault();
    }}
    onEscapeKeydown={(event) => {
      if (writer.busy) event.preventDefault();
    }}
  >
    <form class="grid gap-4" onsubmit={add}>
      <Dialog.Header>
        <Dialog.Title>Add embedding host</Dialog.Title>
        <Dialog.Description>
          Enter the HTTPS origin of a page that shows your apps. Start the host with *. to include
          its subdomains.
        </Dialog.Description>
      </Dialog.Header>
      <div class="space-y-2">
        <Label for="new-embedding-origin">Origin</Label>
        <Input
          id="new-embedding-origin"
          bind:value={input}
          placeholder="https://teams.microsoft.com"
          autocomplete="off"
          spellcheck={false}
          aria-invalid={inputError ? true : undefined}
          aria-describedby={inputError ? "new-embedding-origin-error" : undefined}
          required
        />
        {#if inputError}<p
            id="new-embedding-origin-error"
            class="text-destructive text-xs"
            role="alert"
          >
            {inputError}
          </p>{/if}
      </div>
      {#if writer.error}<Feedback kind="error">{writer.error}</Feedback>{/if}
      <Dialog.Footer>
        <Button variant="outline" disabled={writer.busy} onclick={() => (adding = false)}
          >Cancel</Button
        >
        <Button type="submit" disabled={writer.busy}
          >{writer.busy ? "Adding …" : "Add host"}</Button
        >
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
<RestartDialog {writer} />
