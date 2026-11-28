<script lang="ts">
  import { Button } from "@ui-sdk/svelte/button";
  import { Field, FieldDescription, FieldLabel } from "@ui-sdk/svelte/field";
  import { FileInput, FileInputTrigger } from "@ui-sdk/svelte/file-input";
  import { Textarea } from "@ui-sdk/svelte/textarea";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{data.title}</title></svelte:head>
<main>
  <header>
    <h1>{data.title}</h1>
    <p>Beobachtungen, Ideen und kleine Fortschritte aus unserem Alltag.</p>
    <p class="muted">Angemeldet als {data.user.name || data.user.id}</p>
  </header>
  <section class="panel" aria-labelledby="new-note">
    <h2 id="new-note">Was möchtest du teilen?</h2>
    {#if form?.message}<p role="alert">{form.message}</p>{/if}
    {#if form?.saved}<p role="status">Deine Notiz wurde gespeichert.</p>{/if}
    <form method="POST" enctype="multipart/form-data">
      <Field name="message">
        <FieldLabel>Deine Notiz</FieldLabel>
        <Textarea required maxlength={500} rows={4} placeholder="Was gibt es Neues?" />
      </Field>
      <Field>
        <FieldLabel>Ein Foto dazu</FieldLabel>
        <FileInput name="photo" required accept="image/jpeg,image/png,image/webp">
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
    {#if data.notes.length === 0}
      <p class="muted">Noch ist es hier ruhig. Teile die erste Notiz mit deinem Team.</p>
    {:else}
      <div class="notes">
        {#each data.notes as note (note.id)}
          <article class="note">
            {#if note.photo}
              <img
                src={`/photos/${note.photo}`}
                alt={`Foto zur Notiz von ${note.author}`}
                width="320"
                loading="lazy"
              />
            {/if}
            <div class="note-body">
              <p class="message">{note.message}</p>
              <footer class="muted">
                {note.author} ·
                <time datetime={note.created_at}>{new Date(note.created_at).toISOString().slice(0, 10)}</time>
              </footer>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>
</main>

