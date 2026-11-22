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

const serviceMethodDocumentation = z.strictObject({
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
        // Names of the documented types the signature uses directly.
        uses: z.array(name).max(4096).default([]),
      }),
    )
    .min(1)
    .max(serviceDocumentationMaxSignatures),
});

const serviceEntrypointDocumentation = z.strictObject({
  name,
  ...comment,
  http: z.boolean(),
  methods: z.array(serviceMethodDocumentation).max(1024),
});

const serviceTypeDocumentation = z.strictObject({
  name,
  // How the source declares it, so generated declarations keep its meaning.
  kind: z.enum(["interface", "type"]),
  // A generic declaration's parameters with constraints and defaults, such as `T extends Item = Item`.
  typeParameters: z.array(text).max(32).optional(),
  definition: text,
  ...comment,
  // Names of the documented types the definition uses directly.
  uses: z.array(name).max(4096).default([]),
});

export const serviceDocumentation = z
  .strictObject({
    format: z.literal(3),
    entrypoints: z.array(serviceEntrypointDocumentation).max(32),
    types: z.array(serviceTypeDocumentation).max(4096),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= serviceDocumentationMaxBytes,
    "Service documentation exceeds 8 MiB",
  );

/** Most methods one request may describe. */
export const serviceDescriptionMaxMethods = 20;

/**
 * Selected methods of one entrypoint, the entrypoint's own documentation and
 * the types those methods use. Callers of large APIs read this instead of the
 * whole document.
 */
export const serviceMethodSelection = z.strictObject({
  entrypoint: serviceEntrypointDocumentation,
  types: z.array(serviceTypeDocumentation),
});

/** One method in a list of a service's methods. */
export const serviceMethodSummary = z.strictObject({
  entrypoint: name,
  name: appRpcMethod,
  summary: text,
});

type Documentation = z.infer<typeof serviceDocumentation>;

/** The documented types the given names lead to, following each type's uses. */
const referencedTypes = (types: Documentation["types"], names: string[]) => {
  const byName = new Map(types.map((type) => [type.name, type]));
  const used = new Set<string>();
  const pending = [...names];

  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    const type = byName.get(name);

    if (!type || used.has(name)) continue;
    used.add(name);
    pending.push(...type.uses);
  }

  return types.filter((type) => used.has(type.name));
};

/** The first line of a summary, as method lists show it. */
export const summaryLine = (summary: string) => (summary.split("\n")[0] ?? "").trim().slice(0, 256);

/** Every documented method, in document order, with the first line of its summary. */
export const listServiceMethods = (documentation: Documentation) =>
  documentation.entrypoints.flatMap((entrypoint) =>
    entrypoint.methods.map((method) => ({
      entrypoint: entrypoint.name,
      name: method.name,
      summary: summaryLine(method.summary),
    })),
  );

/**
 * Selects methods of one entrypoint with the types their signatures use.
 * Returns the names it does not know, so callers can point to the method list.
 */
export const selectServiceMethods = (
  documentation: Documentation,
  entrypoint: string,
  methods: string[],
) => {
  const entry = documentation.entrypoints.find((candidate) => candidate.name === entrypoint);
  const known = new Set(entry?.methods.map((method) => method.name));
  const unknown = methods.filter((method) => !known.has(method));

  if (!entry || unknown.length) return { unknown: entry ? unknown : methods, selection: null };
  const selected = entry.methods.filter((method) => methods.includes(method.name));

  const uses = selected.flatMap((method) =>
    method.signatures.flatMap((signature) => signature.uses),
  );

  return {
    unknown,
    selection: serviceMethodSelection.parse({
      entrypoint: { ...entry, methods: selected },
      types: referencedTypes(documentation.types, uses),
    }),
  };
};
