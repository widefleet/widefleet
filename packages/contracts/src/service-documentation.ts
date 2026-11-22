import { z } from "zod";

const reserved = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "then",
  "catch",
  "finally",
  "fetch",
  // App bindings use it to retry a call with answers to its input requests.
  "withInput",
  "connect",
  "scheduled",
  "queue",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

export const appRpcMethod = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
  .refine(
    (name) => !name.startsWith("WIDEFLEET_") && !reserved.has(name),
    "App RPC method is reserved or invalid",
  );

// Clients generated for large APIs, such as a GraphQL schema, document types with
// hundreds of commented fields and hundreds of methods.
const text = z.string().max(262144);

const name = z.string().min(1).max(128);

/**
 * The worker upload part that carries API documentation. Module names cannot
 * use the platform prefix, so it never collides with a module.
 */
export const serviceDocumentationPart = "__widefleet_documentation";

/** Largest encoded service documentation an artifact may carry. */
export const serviceDocumentationMaxBytes = 8 * 1024 * 1024;

const comment = {
  summary: text,
  remarks: text,
  examples: z.array(text).max(16),
  deprecated: text.optional(),
};

export const serviceDocumentationMaxSignatures = 16;

export const serviceDocumentation = z
  .strictObject({
    format: z.literal(1),
    entrypoints: z
      .array(
        z.strictObject({
          name,
          ...comment,
          http: z.boolean(),
          methods: z
            .array(
              z.strictObject({
                name: appRpcMethod,
                ...comment,
                throws: z.array(text).max(16),
                signatures: z
                  .array(
                    z.strictObject({
                      typeParameters: z.array(text).max(32).optional(),
                      parameters: z
                        .array(
                          z.strictObject({
                            name,
                            type: text,
                            description: text,
                            optional: z.boolean(),
                            rest: z.boolean(),
                          }),
                        )
                        .max(32),
                      returns: z.strictObject({ type: text, description: text }),
                    }),
                  )
                  .min(1)
                  .max(serviceDocumentationMaxSignatures),
              }),
            )
            .max(1024),
        }),
      )
      .max(32),
    types: z.array(z.strictObject({ name, definition: text, ...comment })).max(4096),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= serviceDocumentationMaxBytes,
    "Service documentation exceeds 8 MiB",
  );
