import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

export const Route = createFileRoute("/photos/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = z.uuid().safeParse(params.id);

        if (!id.success) return new Response("Foto nicht gefunden.", { status: 404 });
        const file = await env.FILES.get(`photos/${id.data}`);

        if (!file) return new Response("Foto nicht gefunden.", { status: 404 });

        return new Response(await file.arrayBuffer(), {
          headers: {
            "content-type": file.httpMetadata?.contentType ?? "application/octet-stream",
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      },
    },
  },
});
