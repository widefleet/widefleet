import { moduleName, workerMetadata } from "@platform/contracts";
import { Result } from "better-result";
import { z } from "zod";
import { InvalidOperation } from "./errors.ts";
import type { WorkerModule } from "./uploads.ts";

export const readBody = (request: Request, limit: number) =>
  Result.tryPromise({
    try: async () => {
      if (!request.body) return new Uint8Array();
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;
          length += value.byteLength;

          if (length > limit) {
            await reader.cancel();
            throw new Error("Request exceeds the upload limit");
          }

          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = new Uint8Array(length);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return bytes;
    },
    catch: () =>
      new InvalidOperation({
        code: "BAD_REQUEST",
        message: "Upload body is incomplete or exceeds the size limit",
      }),
  });

const moduleType = z
  .enum([
    "application/javascript+module",
    "application/wasm",
    "text/plain",
    "application/octet-stream",
    "application/source-map+json",
  ])
  .transform((type) => {
    switch (type) {
      case "application/javascript+module":
        return "esm";
      case "application/wasm":
        return "wasm";
      case "text/plain":
        return "text";
      case "application/octet-stream":
        return "data";
      case "application/source-map+json":
        return "sourcemap";
    }
  });

export const parseWorkerUpload = (request: Request) =>
  Result.gen(async function* () {
    const bytes = yield* Result.await(readBody(request, 100 * 1024 * 1024));

    return Result.tryPromise({
      try: async () => {
        const form = await new Response(bytes, {
          headers: { "content-type": request.headers.get("content-type") ?? "" },
        }).formData();

        const metadataPart = form.getAll("metadata");

        if (metadataPart.length !== 1) throw new Error("Exactly one metadata part is required");
        const value = metadataPart[0];
        const metadataText = value instanceof File ? await value.text() : z.string().parse(value);

        if (metadataText.length > 64 * 1024) throw new Error("Metadata is too large");
        const metadata = workerMetadata.parse(JSON.parse(metadataText));
        const modules: WorkerModule[] = [];

        for (const [name, part] of form.entries()) {
          if (name === "metadata") continue;

          if (!(part instanceof File)) throw new Error("Worker modules must be file parts");

          if (part.size > 20 * 1024 * 1024 || modules.length >= 532)
            throw new Error("Worker module limit exceeded");
          modules.push({
            name: moduleName.parse(name),
            type: moduleType.parse(part.type),
            bytes: new Uint8Array(await part.arrayBuffer()),
          });
        }

        if (modules.filter((module) => module.type !== "sourcemap").length > 32)
          throw new Error("Too many runtime modules");

        if (modules.filter((module) => module.type === "sourcemap").length > 500)
          throw new Error("Too many source maps");

        return { metadata, modules };
      },
      catch: () =>
        new InvalidOperation({ code: "BAD_REQUEST", message: "Invalid worker multipart upload" }),
    });
  });
