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

/** The name of a documented type, as signatures and `uses` write it. */
export const serviceTypeName = name;

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

/** Most types one request may describe by name. */
export const serviceDescriptionMaxTypes = 20;

/**
 * Bytes a description fills with types its methods reach only through other
 * types. The types a selection names directly are always included.
 */
export const serviceDescriptionBudget = 16384;

/**
 * Selected methods of one entrypoint, the entrypoint's own documentation and
 * the types those methods use. Callers of large APIs read this instead of the
 * whole document. Types beyond the budget are named in `omittedTypes`, so a
 * caller can describe them next.
 */
export const serviceMethodSelection = z.strictObject({
  entrypoint: serviceEntrypointDocumentation,
  types: z.array(serviceTypeDocumentation),
  omittedTypes: z.array(name),
});

/** One method in a list of a service's methods. */
export const serviceMethodSummary = z.strictObject({
  entrypoint: name,
  name: appRpcMethod,
  summary: text,
});

type Documentation = z.infer<typeof serviceDocumentation>;

const encoder = new TextEncoder();

// Bytes as a description serializes them.
const size = (value: Documentation["types"][number] | Documentation["entrypoints"][number]) =>
  encoder.encode(JSON.stringify(value)).byteLength;

/**
 * The documented types the given names lead to. The named types are always
 * included; the types they reach follow breadth first while the selection stays
 * within the budget. A type that does not fit is omitted with the types only it
 * leads to.
 */
const referencedTypes = (types: Documentation["types"], names: string[], used: number) => {
  const byName = new Map(types.map((type) => [type.name, type]));
  const included = new Set<string>();
  const omitted = new Set<string>();
  let total = used;

  const include = (type: Documentation["types"][number]) => {
    included.add(type.name);
    total += size(type);

    return type.uses;
  };

  let level = [...new Set(names)].flatMap((name) => {
    const type = byName.get(name);

    return type ? include(type) : [];
  });

  while (level.length)
    level = [...new Set(level)].flatMap((name) => {
      const type = byName.get(name);

      if (!type || included.has(name) || omitted.has(name)) return [];

      if (total + size(type) <= serviceDescriptionBudget) return include(type);

      omitted.add(name);

      return [];
    });

  return {
    types: types.filter((type) => included.has(type.name)),
    omittedTypes: [...omitted],
  };
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
 * Selects methods of one entrypoint and named types with the types they use.
 * Returns what it does not know, the entrypoint or names, so callers can point
 * to the method list.
 */
export const selectServiceMethods = (
  documentation: Documentation,
  entrypoint: string,
  selection: { methods: string[]; types: string[] },
) => {
  const entry = documentation.entrypoints.find((candidate) => candidate.name === entrypoint);
  const methods = new Set(entry?.methods.map((method) => method.name));
  const types = new Set(documentation.types.map((type) => type.name));

  const unknown = {
    entrypoint: !entry,
    methods: entry ? selection.methods.filter((method) => !methods.has(method)) : selection.methods,
    types: selection.types.filter((type) => !types.has(type)),
  };

  if (!entry || unknown.methods.length || unknown.types.length) return { unknown, selection: null };
  const selected = entry.methods.filter((method) => selection.methods.includes(method.name));
  const documented = { ...entry, methods: selected };

  const uses = selected.flatMap((method) =>
    method.signatures.flatMap((signature) => signature.uses),
  );

  return {
    unknown,
    selection: serviceMethodSelection.parse({
      entrypoint: documented,
      ...referencedTypes(documentation.types, [...selection.types, ...uses], size(documented)),
    }),
  };
};
