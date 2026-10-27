import * as z from "zod";

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

export const objectOperation = z.discriminatedUnion("method", [
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

export type ObjectOperation = z.infer<typeof objectOperation>;

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
