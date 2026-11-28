<script lang="ts">
  import { Button } from "@ui-sdk/svelte/button";
  import { Field, FieldDescription, FieldLabel } from "@ui-sdk/svelte/field";
  import { FileInput, FileInputTrigger } from "@ui-sdk/svelte/file-input";
  import { Textarea } from "@ui-sdk/svelte/textarea";
  import {
    Toast,
    ToastDescription,
    ToastRegion,
    ToastTitle,
    createToaster,
  } from "@ui-sdk/svelte/toast";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { captureError } from "../lib/capture-error.ts";
  import { createNote, getNotes } from "../lib/notes.remote.ts";
  import { shrinkPhoto } from "../lib/shrink-photo.ts";

  const title = "Team-Notizen";

  const toast = createToaster();

  // Shared photos are shown from the device until the server's copy has loaded.
  const previews = new SvelteMap<string, string>();

  // Notes the server has not confirmed yet.
  const uploading = new SvelteSet<string>();

  const showUploaded = (id: string, preview: string) => {
    previews.set(id, preview);
    const uploaded = new Image();

    uploaded.src = `/photos/${id}`;
    void uploaded
      .decode()
      .catch(() => undefined)
      .finally(() => {
        previews.delete(id);
        URL.revokeObjectURL(preview);
      });
  };

  let message = $state("");

  let photos = $state<File[]>([]);

  // The chosen photo is replaced by a smaller copy while the note is written.
  const choosePhotos = (chosen: File[]) => {
    photos = chosen;
    const photo = chosen[0];

    if (!photo) return;

    shrinkPhoto(photo).then(
      (smaller) => {
        if (photos[0] === photo) photos = [smaller];
      },
      (cause: unknown) => captureError(cause),
    );
  };

  // The note appears at once. If it cannot be saved, it disappears and returns to the form.
  const share: Parameters<typeof createNote.enhance>[0] = async (form) => {
    const draft = { message: message.trim(), photos };
    const photo = photos[0];

    if (!photo) return;
    const id = crypto.randomUUID();
    const preview = URL.createObjectURL(photo);

    previews.set(id, preview);
    uploading.add(id);

    const submission = form.submit().updates(
      getNotes().withOverride((current) => ({
        ...current,
        notes: [
          {
            id,
            author: current.user.name || current.user.id,
            message: draft.message,
            photo: id,
            created_at: new Date().toISOString(),
          },
          ...current.notes,
        ],
      })),
    );

    message = "";
    photos = [];

    try {
      if ((await submission) && form.result) showUploaded(form.result.id, preview);
      else {
        URL.revokeObjectURL(preview);
        message = draft.message;
        photos = draft.photos;
        toast.error("Notiz nicht geteilt", {
          description: (form.fields.allIssues() ?? []).map((issue) => issue.message).join(" "),
        });
      }
    } catch (cause) {
      URL.revokeObjectURL(preview);
      captureError(cause);
      message = draft.message;
      photos = draft.photos;
      toast.error("Notiz nicht geteilt", { description: "Bitte erneut versuchen." });
    } finally {
      previews.delete(id);
      uploading.delete(id);
    }
  };
</script>

<svelte:head><title>{title}</title></svelte:head>
<main>
  <svelte:boundary>
    {@const { user, notes } = await getNotes()}
    <header>
      <h1>{title}</h1>
      <p>Beobachtungen, Ideen und kleine Fortschritte aus unserem Alltag.</p>
      <p class="muted">Angemeldet als {user.name || user.id}</p>
    </header>
    <section class="panel" aria-labelledby="new-note">
      <h2 id="new-note">Was möchtest du teilen?</h2>
      <form {...createNote.enhance(share)} enctype="multipart/form-data">
        <Field name={createNote.fields.message.as("text").name}>
          <FieldLabel>Deine Notiz</FieldLabel>
          <Textarea
            bind:value={message}
            required
            maxlength={500}
            rows={4}
            placeholder="Was gibt es Neues?"
          />
        </Field>
        <Field>
          <FieldLabel>Ein Foto dazu</FieldLabel>
          <FileInput
            name={createNote.fields.photo.as("file").name}
            value={photos}
            onValueChange={choosePhotos}
            required
            accept="image/jpeg,image/png,image/webp"
          >
            {#snippet children({ value })}
              <FileInputTrigger>Foto auswählen</FileInputTrigger>
              <span class="muted">{value[0]?.name ?? "Kein Foto ausgewählt"}</span>
            {/snippet}
          </FileInput>
          <FieldDescription>JPEG, PNG oder WebP, bis 5 MB.</FieldDescription>
        </Field>
        <Button type="submit" data-variant="solid">Notiz teilen</Button>
      </form>
    </section>
    <section aria-labelledby="notes">
      <h2 id="notes">Aus dem Team</h2>
      {#if notes.length === 0}
        <p class="muted">Noch ist es hier ruhig. Teile die erste Notiz mit deinem Team.</p>
      {:else}
        <div class="notes">
          {#each notes as note (note.id)}
            <article class="note" data-uploading={uploading.has(note.id) || undefined}>
              <img
                src={previews.get(note.id) ?? `/photos/${note.photo}`}
                alt={`Foto zur Notiz von ${note.author}`}
                width="320"
                loading="lazy"
              />
              <div class="note-body">
                <p class="message">{note.message}</p>
                <footer class="muted">
                  {note.author} ·
                  {#if uploading.has(note.id)}
                    Wird hochgeladen …
                  {:else}
                    <time datetime={note.created_at}
                      >{new Date(note.created_at).toISOString().slice(0, 10)}</time
                    >
                  {/if}
                </footer>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>
    {#snippet failed(_, retry)}
      <p role="alert">Notizen konnten nicht geladen werden.</p>
      <Button onclick={retry}>Erneut versuchen</Button>
    {/snippet}
  </svelte:boundary>
</main>
<ToastRegion toaster={toast}>
  <Toast>
    <ToastTitle />
    <ToastDescription />
  </Toast>
</ToastRegion>
