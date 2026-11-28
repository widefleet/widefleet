import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { FileInput, FileInputTrigger } from "@ui-sdk/react/file-input";
import { Textarea } from "@ui-sdk/react/textarea";
import {
  Toast,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  createToaster,
} from "@ui-sdk/react/toast";
import { useEffect, useState } from "react";
import { getNotes, saveNote } from "../lib/notes.functions.ts";
import { captureError } from "../lib/capture-error.ts";
import { shrinkPhoto } from "../lib/shrink-photo.ts";

const title = "Team-Notizen";

const notesQuery = queryOptions({ queryKey: ["notes"], queryFn: () => getNotes() });

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(notesQuery),
  head: () => ({ meta: [{ title }] }),
  component: Notes,
});

/** The server checked the note and did not save it; the reason is meant for the person. */
class Rejected extends Error {}

function Notes() {
  const { data } = useSuspenseQuery(notesQuery);
  const queryClient = useQueryClient();
  const save = useServerFn(saveNote);
  const [toast] = useState(() => createToaster());
  const [message, setMessage] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  // Shared photos are shown from the device until the server's copy has loaded.
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const dropPreview = (id: string) =>
    setPreviews((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );

  // Notes the server has not confirmed yet.
  const [uploading, setUploading] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);
  useEffect(() => () => toast.dismiss(), [toast]);

  // The note appears at once. If it cannot be saved, it disappears and returns to the form.
  const mutation = useMutation({
    mutationFn: async (draft: { id: string; message: string; photo: File; preview: string }) => {
      const form = new FormData();

      form.set("message", draft.message);
      form.set("photo", draft.photo);
      const result = await save({ data: form });

      if (!result.saved) throw new Rejected(result.message);

      return result;
    },
    onMutate: async (draft) => {
      await queryClient.cancelQueries(notesQuery);
      const previous = queryClient.getQueryData(notesQuery.queryKey);

      setPreviews((current) => ({ ...current, [draft.id]: draft.preview }));
      setUploading((current) => [...current, draft.id]);
      queryClient.setQueryData(
        notesQuery.queryKey,
        (current) =>
          current && {
            ...current,
            notes: [
              {
                id: draft.id,
                author: current.user.name || current.user.id,
                message: draft.message,
                photo: draft.id,
                created_at: new Date().toISOString(),
              },
              ...current.notes,
            ],
          },
      );

      return { previous };
    },
    // The note list returns with the response, so the browser needs no second request.
    onSuccess: ({ id, notes }, draft) => {
      queryClient.setQueryData(notesQuery.queryKey, (current) => current && { ...current, notes });
      setPreviews((current) => ({ ...current, [id]: draft.preview }));
      const uploaded = new Image();

      uploaded.src = `/photos/${id}`;
      void uploaded
        .decode()
        .catch(() => undefined)
        .finally(() => {
          dropPreview(id);
          URL.revokeObjectURL(draft.preview);
        });
    },
    onError: (cause, draft, context) => {
      queryClient.setQueryData(notesQuery.queryKey, context?.previous);
      URL.revokeObjectURL(draft.preview);
      setMessage(draft.message);
      setPhotos([draft.photo]);

      if (!(cause instanceof Rejected)) captureError(cause);
      toast.error("Notiz nicht geteilt", {
        description: cause instanceof Rejected ? cause.message : "Bitte erneut versuchen.",
      });
    },
    onSettled: (_, __, draft) => {
      dropPreview(draft.id);
      setUploading((current) => current.filter((id) => id !== draft.id));
    },
  });

  // The chosen photo is replaced by a smaller copy while the note is written.
  const choosePhotos = (files: File[]) => {
    setPhotos(files);
    const photo = files[0];

    if (!photo) return;

    shrinkPhoto(photo).then(
      (smaller) => setPhotos((current) => (current[0] === photo ? [smaller] : current)),
      (cause: unknown) => captureError(cause),
    );
  };

  return (
    <main>
      <header>
        <h1>{title}</h1>
        <p>Beobachtungen, Ideen und kleine Fortschritte aus unserem Alltag.</p>
        <p className="muted">Angemeldet als {data.user.name || data.user.id}</p>
      </header>
      <section className="panel" aria-labelledby="new-note">
        <h2 id="new-note">Was möchtest du teilen?</h2>
        <form
          method="post"
          encType="multipart/form-data"
          onSubmit={(event) => {
            event.preventDefault();
            const photo = photos[0];

            if (!photo) return;
            mutation.mutate({
              id: crypto.randomUUID(),
              message: message.trim(),
              photo,
              preview: URL.createObjectURL(photo),
            });
            setMessage("");
            setPhotos([]);
          }}
        >
          <Field>
            <FieldLabel>Deine Notiz</FieldLabel>
            <Textarea
              value={message}
              onValueChange={setMessage}
              required
              maxLength={500}
              rows={4}
              placeholder="Was gibt es Neues?"
            />
          </Field>
          <Field>
            <FieldLabel>Ein Foto dazu</FieldLabel>
            <FileInput
              value={photos}
              onValueChange={choosePhotos}
              required
              accept="image/jpeg,image/png,image/webp"
            >
              {({ value }) => (
                <>
                  <FileInputTrigger>Foto auswählen</FileInputTrigger>
                  <span className="muted">{value[0]?.name ?? "Kein Foto ausgewählt"}</span>
                </>
              )}
            </FileInput>
            <FieldDescription>JPEG, PNG oder WebP, bis 5 MB.</FieldDescription>
          </Field>
          <Button type="submit" data-variant="solid" disabled={!ready}>
            Notiz teilen
          </Button>
        </form>
      </section>
      <section aria-labelledby="notes">
        <h2 id="notes">Aus dem Team</h2>
        {data.notes.length === 0 ? (
          <p className="muted">Noch ist es hier ruhig. Teile die erste Notiz mit deinem Team.</p>
        ) : (
          <div className="notes">
            {data.notes.map((note) => {
              const pending = uploading.includes(note.id);

              return (
                <article key={note.id} className="note" data-uploading={pending || undefined}>
                  <img
                    src={previews[note.id] ?? `/photos/${note.photo}`}
                    alt={`Foto zur Notiz von ${note.author}`}
                    width={320}
                    loading="lazy"
                  />
                  <div className="note-body">
                    <p className="message">{note.message}</p>
                    <footer className="muted">
                      {note.author} ·{" "}
                      {pending ? (
                        "Wird hochgeladen …"
                      ) : (
                        <time dateTime={note.created_at}>
                          {new Date(note.created_at).toISOString().slice(0, 10)}
                        </time>
                      )}
                    </footer>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <ToastRegion toaster={toast}>
        {() => (
          <Toast>
            <ToastTitle />
            <ToastDescription />
          </Toast>
        )}
      </ToastRegion>
    </main>
  );
}
