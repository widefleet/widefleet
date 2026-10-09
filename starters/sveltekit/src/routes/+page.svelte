<script lang="ts">
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{data.title}</title></svelte:head>
<main>
  <header><p class="eyebrow">UNSER TEAM</p><h1>{data.title}</h1><p>Beobachtungen, Ideen und kleine Fortschritte aus unserem Alltag.</p><p class="identity">Angemeldet als {data.user.name || data.user.id}</p></header>
  <section aria-labelledby="new-note"><h2 id="new-note">Was möchtest du teilen?</h2>
    {#if form?.message}<p role="alert">{form.message}</p>{/if}
    {#if form?.saved}<p role="status">Deine Notiz wurde gespeichert.</p>{/if}
    <form method="POST" enctype="multipart/form-data"><label for="message">Deine Notiz</label><textarea id="message" name="message" required maxlength="500" rows="4" placeholder="Was gibt es Neues?"></textarea><label for="photo">Ein Foto dazu</label><input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" required aria-describedby="photo-hint" /><p id="photo-hint" class="hint">JPEG, PNG oder WebP, bis 5 MB.</p><button>Notiz teilen</button></form>
  </section>
  <section aria-labelledby="notes"><h2 id="notes">Aus dem Team</h2>
    {#if data.notes.length === 0}<p>Noch ist es hier ruhig. Teile die erste Notiz mit deinem Team.</p>{:else}<div class="notes">{#each data.notes as note (note.id)}<article>{#if note.photo}<img src={`/photos/${note.photo}`} alt={`Foto zur Notiz von ${note.author}`} loading="lazy" />{/if}<div class="content"><p>{note.message}</p><footer>{note.author}<br /><time datetime={note.created_at}>{new Date(note.created_at).toISOString().slice(0, 10)}</time></footer></div></article>{/each}</div>{/if}
  </section>
</main>

<style>
  :global(body) { margin: 0; background: #f4f2ed; color: #23362e; font-family: ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 920px; margin: 64px auto; padding: 0 24px; }
  header { max-width: 650px; margin-bottom: 40px; }
  .eyebrow { color: #587165; font-size: .75rem; letter-spacing: .15em; font-weight: 700; }
  h1 { font-size: clamp(2.4rem, 7vw, 4rem); letter-spacing: -.055em; margin: 16px 0; line-height: 1.05; }
  h2 { font-size: 1.25rem; margin-top: 0; }
  p { line-height: 1.65; }
  .identity, .hint, footer { font-size: .85rem; color: #587165; }
  section { margin: 32px 0; }
  section:first-of-type { background: #fff; border: 1px solid #d7dfd7; border-radius: 12px; padding: 28px; }
  label { display: block; margin-top: 20px; font-weight: 600; }
  textarea, input, button { font: inherit; }
  textarea { display: block; width: 100%; box-sizing: border-box; margin: 8px 0 20px; border: 1px solid #9eafa3; border-radius: 6px; padding: 12px; resize: vertical; }
  input { margin-top: 10px; max-width: 100%; }
  button { border: none; border-radius: 6px; background: #245e43; color: #fff; padding: 13px 22px; cursor: pointer; margin-top: 12px; }
  button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 3px solid #a97b2a; outline-offset: 3px; }
  .notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 24px; }
  article { border: 1px solid #d7dfd7; border-radius: 12px; overflow: hidden; background: white; }
  img { width: 100%; height: 240px; object-fit: cover; }
  .content { padding: 20px; }
  .content p { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 0; }
  footer { margin-top: 24px; line-height: 1.6; }
  [role="alert"] { color: #962e27; }
  [role="status"] { color: #245e43; }
</style>
