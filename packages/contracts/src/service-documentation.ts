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

const serviceTypeDocumentation = z.strictObject({ name, definition: text, ...comment });

export const serviceDocumentation = z
  .strictObject({
    format: z.literal(1),
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

// Generated type names are complete type expressions: `Item`, `One.Item`,
// `Page<Item>` or `import("./model").Item`. Each is found under its first plain
// identifier, and a text uses it when it contains the whole name, not as part
// of a longer name such as `One.ItemDetails` or `Two.Item`.
const qualifier = /^import\("(?:[^"\\]|\\.)*"\)\./;

const identifier = /import\("(?:[^"\\]|\\.)*"\)\.[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*/g;

const namePart = /[\w$.]/;

const declaration =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|class|enum)\s+[A-Za-z_$][\w$]*/;

const usesName = (text: string, name: string) => {
  for (let index = text.indexOf(name); index >= 0; index = text.indexOf(name, index + 1)) {
    const before = text[index - 1];
    const after = text[index + name.length];

    if (!(before && namePart.test(before)) && !(after && /[\w$]/.test(after))) return true;
  }

  return false;
};

const leadingIdentifier = (text: string) =>
  /^[A-Za-z_$][\w$]*/.exec(text.replace(qualifier, ""))?.[0];

/** The documented types the texts use, directly or through other documented types. */
const referencedTypes = (types: Documentation["types"], texts: string[]) => {
  const candidates = new Map<string, Documentation["types"]>();

  for (const type of types) {
    const key = leadingIdentifier(type.name);

    if (key) candidates.set(key, [...(candidates.get(key) ?? []), type]);
  }

  const used = new Set<string>();
  const pending = [...texts];

  for (let text = pending.pop(); text !== undefined; text = pending.pop())
    for (const [token] of text.matchAll(identifier)) {
      const key = leadingIdentifier(token);

      for (const type of (key && candidates.get(key)) || []) {
        if (used.has(type.name) || !usesName(text, type.name)) continue;
        used.add(type.name);
        // A definition starts by declaring its own short name, which is not a use.
        pending.push(type.definition.replace(declaration, ""));
      }
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

  const texts = selected.flatMap((method) =>
    method.signatures.flatMap((signature) => [
      ...(signature.typeParameters ?? []),
      ...signature.parameters.map((parameter) => parameter.type),
      signature.returns.type,
    ]),
  );

  return {
    unknown,
    selection: serviceMethodSelection.parse({
      entrypoint: { ...entry, methods: selected },
      types: referencedTypes(documentation.types, texts),
    }),
  };
};
