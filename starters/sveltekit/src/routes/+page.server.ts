import { env } from "cloudflare:workers";
import { error, fail } from "@sveltejs/kit";
import { Result } from "better-result";
import { z } from "zod";
import { database, DataUnavailable, listNotes } from "../lib/server/data.ts";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const notes = await listNotes();

  if (notes.isErr()) error(503, notes.error.message);

  return { title: env.APP_NAME, user: locals.user, notes: notes.value };
};

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const fields = await request.formData();
    const message = z.string().trim().min(1).max(500).safeParse(fields.get("message"));
    const photo = fields.get("photo");

    if (!message.success)
      return fail(400, { message: "Bitte eine Notiz mit höchstens 500 Zeichen eingeben." });

    if (
      !(photo instanceof File) ||
      photo.size === 0 ||
      photo.size > 5 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp"].includes(photo.type)
    ) {
      return fail(400, {
        message: "Bitte ein Foto als JPEG, PNG oder WebP auswählen (höchstens 5 MB).",
      });
    }

    const db = await database();

    if (db.isErr()) return fail(503, { message: db.error.message });
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
            .bind(id, locals.user.id, locals.user.name, message.data, id, new Date().toISOString())
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

    if (saved.isErr()) return fail(503, { message: saved.error.message });

    return { saved: true };
  },
};
