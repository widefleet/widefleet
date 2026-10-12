import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getNotes, saveNote } from "../lib/notes.functions.ts";
import { captureError } from "../lib/capture-error.ts";

export const Route = createFileRoute("/")({
  loader: () => getNotes(),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? "Team-Notizen" }] }),
  component: Notes,
});

function Notes() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [result, setResult] = useState<{ saved: boolean; message: string }>();
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);

  const submit = async (form: HTMLFormElement) => {
    setPending(true);
    setResult(undefined);

    try {
      const saved = await saveNote({ data: new FormData(form) });

      setResult(saved);

      if (saved.saved) {
        form.reset();
        await router.invalidate();
      }
    } catch (cause) {
      captureError(cause);
      setResult((current) =>
        current?.saved
          ? {
              saved: true,
              message:
                "Deine Notiz wurde gespeichert. Bitte lade die Seite neu, um die Ansicht zu aktualisieren.",
            }
          : { saved: false, message: "Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen." },
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main>
      <header>
        <p className="eyebrow">UNSER TEAM</p>
        <h1>{data.title}</h1>
        <p>Beobachtungen, Ideen und kleine Fortschritte aus unserem Alltag.</p>
        <p className="identity">Angemeldet als {data.user.name || data.user.id}</p>
      </header>
      <section aria-labelledby="new-note">
        <h2 id="new-note">Was möchtest du teilen?</h2>
        {result && <p role={result.saved ? "status" : "alert"}>{result.message}</p>}
        <form
          method="post"
          encType="multipart/form-data"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <label htmlFor="message">Deine Notiz</label>
          <textarea
            id="message"
            name="message"
            required
            maxLength={500}
            rows={4}
            placeholder="Was gibt es Neues?"
          />
          <label htmlFor="photo">Ein Foto dazu</label>
          <input
            id="photo"
            name="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            required
            aria-describedby="photo-hint"
          />
          <p id="photo-hint" className="hint">
            JPEG, PNG oder WebP, bis 5 MB.
          </p>
          <button disabled={pending || !ready}>
            {pending ? "Wird gespeichert …" : "Notiz teilen"}
          </button>
        </form>
      </section>
      <section aria-labelledby="notes">
        <h2 id="notes">Aus dem Team</h2>
        {data.notes.length === 0 ? (
          <p>Noch ist es hier ruhig. Teile die erste Notiz mit deinem Team.</p>
        ) : (
          <div className="notes">
            {data.notes.map((note) => (
              <article key={note.id}>
                {note.photo && (
                  <img
                    src={`/photos/${note.photo}`}
                    alt={`Foto zur Notiz von ${note.author}`}
                    loading="lazy"
                  />
                )}
                <div className="content">
                  <p>{note.message}</p>
                  <footer>
                    {note.author}
                    <br />
                    <time dateTime={note.created_at}>
                      {new Date(note.created_at).toISOString().slice(0, 10)}
                    </time>
                  </footer>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
