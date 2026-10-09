import { env } from "cloudflare:workers";
import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";

export const GET: RequestHandler = async ({ params }) => {
  const id = z.uuid().safeParse(params["id"]);

  if (!id.success) error(404, "Foto nicht gefunden.");
  const file = await env.FILES.get(`photos/${id.data}`);

  if (!file) error(404, "Foto nicht gefunden.");

  return new Response(await file.arrayBuffer(), {
    headers: {
      "content-type": file.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
};
