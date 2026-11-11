import { z } from "zod";

const reserved = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "then",
  "catch",
  "finally",
  "fetch",
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

const text = z.string().max(32768);

const name = z.string().min(1).max(128);

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
            .max(128),
        }),
      )
      .max(32),
    types: z.array(z.strictObject({ name, definition: text, ...comment })).max(128),
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144,
    "Service documentation exceeds 256 KiB",
  );
