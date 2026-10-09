import { WorkerEntrypoint } from "cloudflare:workers";
import * as z from "zod";
import { nativeBinding } from "./storage.ts";
import type { BindingProperties, ParentEnvironment } from "./types.ts";

const httpMetadata = z.strictObject({
  contentType: z.string().optional(),
  contentLanguage: z.string().optional(),
  contentDisposition: z.string().optional(),
  contentEncoding: z.string().optional(),
  cacheControl: z.string().optional(),
  cacheExpiry: z.coerce.date().optional(),
});

const condition = z.strictObject({
  etagMatches: z.string().optional(),
  etagDoesNotMatch: z.string().optional(),
  uploadedBefore: z.coerce.date().optional(),
  uploadedAfter: z.coerce.date().optional(),
  secondsGranularity: z.boolean().optional(),
});

const putOptions = z.strictObject({
  httpMetadata: httpMetadata.optional(),
  customMetadata: z.record(z.string(), z.string()).optional(),
  onlyIf: condition.optional(),
  storageClass: z.string().optional(),
  md5: z.string().optional(),
  sha1: z.string().optional(),
  sha256: z.string().optional(),
  sha384: z.string().optional(),
  sha512: z.string().optional(),
});

const range = z.union([
  z.strictObject({ offset: z.number(), length: z.number().optional() }),
  z.strictObject({ length: z.number() }),
  z.strictObject({ suffix: z.number() }),
]);

const operation = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("head"), key: z.string() }),
  z.strictObject({
    method: z.literal("get"),
    key: z.string(),
    options: z.strictObject({ range: range.optional(), onlyIf: condition.optional() }).optional(),
  }),
  z.strictObject({ method: z.literal("put"), key: z.string(), options: putOptions.optional() }),
  z.strictObject({ method: z.literal("delete"), keys: z.union([z.string(), z.array(z.string())]) }),
  z.strictObject({
    method: z.literal("list"),
    options: z
      .object({
        limit: z.number().optional(),
        prefix: z.string().optional(),
        cursor: z.string().optional(),
        delimiter: z.string().optional(),
        startAfter: z.string().optional(),
        include: z.array(z.enum(["httpMetadata", "customMetadata"])).optional(),
      })
      .optional(),
  }),
  z.strictObject({
    method: z.literal("createMultipartUpload"),
    key: z.string(),
    options: putOptions.optional(),
  }),
  z.strictObject({
    method: z.literal("uploadPart"),
    key: z.string(),
    uploadId: z.string(),
    partNumber: z.number(),
  }),
  z.strictObject({
    method: z.literal("complete"),
    key: z.string(),
    uploadId: z.string(),
    parts: z.array(z.strictObject({ partNumber: z.number(), etag: z.string() })),
  }),
  z.strictObject({ method: z.literal("abort"), key: z.string(), uploadId: z.string() }),
]);

export type ObjectOperation = z.infer<typeof operation>;

const metadata = (object: R2Object) => ({
  key: object.key,
  version: object.version,
  size: object.size,
  etag: object.etag,
  httpEtag: object.httpEtag,
  uploaded: object.uploaded.toISOString(),
  httpMetadata: object.httpMetadata,
  customMetadata: object.customMetadata,
  range: object.range,
  storageClass: object.storageClass,
  checksums: object.checksums.toJSON(),
});

export const objectMetadata = z.strictObject({
  key: z.string(),
  version: z.string(),
  size: z.number(),
  etag: z.string(),
  httpEtag: z.string(),
  uploaded: z.coerce.date(),
  httpMetadata: httpMetadata.optional(),
  customMetadata: z.record(z.string(), z.string()).optional(),
  range: range.optional(),
  storageClass: z.string(),
  checksums: z.record(z.string(), z.string()),
});

export const objectListing = z.strictObject({
  objects: z.array(objectMetadata),
  truncated: z.boolean(),
  cursor: z.string().optional(),
  delimitedPrefixes: z.array(z.string()),
});

export class Objects extends WorkerEntrypoint<ParentEnvironment, BindingProperties> {
  override async fetch(request: Request) {
    try {
      const input = operation.parse(
        JSON.parse(decodeURIComponent(request.headers.get("x-widefleet-operation") ?? "null")),
      );

      const bucket = nativeBinding(this.env, this.ctx.props.name, "r2_bucket");

      switch (input.method) {
        case "get": {
          // SAFETY: Validated JSON omits undefined fields; date conditions were decoded above.
          const object = await bucket.get(input.key, input.options as R2GetOptions);

          if (!object) return new Response(null, { status: 404 });
          const hasBody = "body" in object;

          return new Response(hasBody ? object.body : null, {
            headers: {
              "x-widefleet-object": encodeURIComponent(JSON.stringify(metadata(object))),
              "x-widefleet-body": String(hasBody),
            },
          });
        }

        case "head": {
          const object = await bucket.head(input.key);

          return Response.json(object ? metadata(object) : null);
        }

        case "put": {
          // SAFETY: Validated JSON omits undefined fields and contains native R2 option values.
          const object = await bucket.put(input.key, request.body, input.options as R2PutOptions);

          return Response.json(object ? metadata(object) : null);
        }

        case "delete":
          await bucket.delete(input.keys);

          return Response.json(null);
        case "list": {
          // SAFETY: Optional JSON fields are absent, never explicitly undefined.
          const page = await bucket.list(input.options as R2ListOptions);

          return Response.json({ ...page, objects: page.objects.map(metadata) });
        }

        case "createMultipartUpload": {
          // SAFETY: Validated JSON contains the native multipart metadata options.
          const upload = await bucket.createMultipartUpload(
            input.key,
            input.options as R2MultipartOptions,
          );

          return Response.json({ key: upload.key, uploadId: upload.uploadId });
        }

        case "uploadPart":
          return Response.json(
            await bucket
              .resumeMultipartUpload(input.key, input.uploadId)
              .uploadPart(input.partNumber, request.body ?? new Uint8Array()),
          );
        case "complete":
          return Response.json(
            metadata(
              await bucket.resumeMultipartUpload(input.key, input.uploadId).complete(input.parts),
            ),
          );
        case "abort":
          await bucket.resumeMultipartUpload(input.key, input.uploadId).abort();

          return Response.json(null);
      }
    } catch (cause) {
      return Response.json({ error: String(cause) }, { status: 400 });
    }
  }
}
