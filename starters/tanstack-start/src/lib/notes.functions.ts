import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { Result } from "better-result";
import { z } from "zod";
import { database, DataUnavailable, listNotes } from "./server/data.ts";
import { captureError } from "./server/capture-error.ts";

export const getNotes = createServerFn().handler(async ({ context }) => {
  const notes = await listNotes();

  if (notes.isErr()) throw notes.error;

  return { title: env.APP_NAME, user: context.user, notes: notes.value };
});

export const saveNote = createServerFn({ method: "POST" })
  .validator(z.instanceof(FormData))
  .handler(async ({ data, context }) => {
    const message = z.string().trim().min(1).max(500).safeParse(data.get("message"));
    const photo = data.get("photo");

    if (!message.success)
      return { saved: false, message: "Bitte eine Notiz mit höchstens 500 Zeichen eingeben." };

    if (
      !(photo instanceof File) ||
      photo.size === 0 ||
      photo.size > 5 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp"].includes(photo.type)
    )
      return {
        saved: false,
        message: "Bitte ein Foto als JPEG, PNG oder WebP auswählen (höchstens 5 MB).",
      };

    const db = await database();

    if (db.isErr()) {
      captureError(db.error);

      return { saved: false, message: db.error.message };
    }

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
            .bind(
              id,
              context.user.id,
              context.user.name,
              message.data,
              id,
              new Date().toISOString(),
            )
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

    if (saved.isErr()) {
      captureError(saved.error);

      return { saved: false, message: saved.error.message };
    }

    return { saved: true, message: "Deine Notiz wurde gespeichert." };
  });
