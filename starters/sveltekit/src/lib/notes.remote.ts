import { env } from "cloudflare:workers";
import { error, invalid } from "@sveltejs/kit";
import { form, getRequestEvent, query, requested } from "$app/server";
import { Result } from "better-result";
import { z } from "zod";
import { database, DataUnavailable, listNotes } from "./server/data.ts";

export const getNotes = query(async () => {
  const notes = await listNotes();

  if (notes.isErr()) error(503, notes.error.message);

  return { user: getRequestEvent().locals.user, notes: notes.value };
});

export const createNote = form(
  z.object({
    message: z.string().trim().min(1).max(500, "Bitte höchstens 500 Zeichen eingeben."),
    photo: z
      .file()
      .min(1)
      .max(5 * 1024 * 1024, "Das Foto darf höchstens 5 MB groß sein.")
      .mime(["image/jpeg", "image/png", "image/webp"], "Bitte ein JPEG, PNG oder WebP wählen."),
  }),
  async ({ message, photo }) => {
    const { user } = getRequestEvent().locals;
    const db = await database();

    if (db.isErr()) invalid(db.error.message);
    const id = crypto.randomUUID();
    const key = `photos/${id}`;

    const saved = await Result.tryPromise({
      try: async () => {
        await env.FILES.put(key, await photo.arrayBuffer(), {
          httpMetadata: { contentType: photo.type },
        });

        try {
          await db.value
            .prepare(
              "INSERT INTO notes (id, author_id, author, message, photo, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(id, user.id, user.name, message, id, new Date().toISOString())
            .run();
        } catch (cause) {
          await env.FILES.delete(key);
          throw cause;
        }
      },
      catch: (cause) =>
        new DataUnavailable({
          message: "Die Notiz konnte nicht gespeichert werden. Bitte erneut versuchen.",
          cause,
        }),
    });

    if (saved.isErr()) invalid(saved.error.message);

    // The note list returns with this response, so the browser needs no second request.
    await requested(getNotes, 1).refreshAll();

    return { id };
  },
);
