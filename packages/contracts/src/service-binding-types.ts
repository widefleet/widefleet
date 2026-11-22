import type { z } from "zod";
import type { serviceDocumentation } from "./service-documentation.ts";
import { rewriteTypeReferences } from "./service-type-names.ts";

type Documentation = z.infer<typeof serviceDocumentation>;

type Comment = {
  summary: string;
  remarks: string;
  examples: string[];
  deprecated?: string | undefined;
};

const validIdentifier = /^[A-Za-z_$][\w$]*$/;

// The base name of a documented declaration, without its type parameters: `Page` for `Page<T>`.
const declarationName = (name: string) => {
  let depth = 0;
  let quoted: string | null = null;

  for (let index = 0; index < name.length; index += 1) {
    const char = name[index];

    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === quoted) quoted = null;
    } else if (char === '"') quoted = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "<" && depth === 0) return name.slice(0, index);
  }

  return name;
};

// `import("./src/a-b").Item.Kind` → `src_a_b_Item_Kind`; `Page.Item` → `Page_Item`.
const identifierFor = (name: string) => {
  const qualified = /^import\("((?:[^"\\]|\\.)*)"\)\.(.+)$/.exec(name);

  const module = (qualified?.[1] ?? "")
    .replace(/^\.\//, "")
    .replace(/\.[cm]?[jt]sx?$/, "")
    .replace(/(?:^|\/)index$/, "");

  const parts = [...module.split(/[^A-Za-z0-9_$]+/), ...(qualified?.[2] ?? name).split(".")];
  const joined = parts.filter(Boolean).join("_");

  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
};

/**
 * Valid, distinct identifiers for documented declarations. Unqualified names stay as they are;
 * module-qualified and dotted names are joined with underscores, and a name that would repeat
 * another gains underscores until it is unique. Sorting first keeps the result independent of
 * document order.
 */
const declarationIdentifiers = (names: readonly string[]) => {
  const sorted = [...new Set(names)].sort();
  const identifiers = new Map<string, string>();
  const taken = new Set(sorted.filter((name) => validIdentifier.test(name)));

  for (const name of sorted) {
    if (validIdentifier.test(name)) {
      identifiers.set(name, name);
      continue;
    }

    let candidate = identifierFor(name);

    while (taken.has(candidate)) candidate = `${candidate}_`;
    taken.add(candidate);
    identifiers.set(name, candidate);
  }

  return identifiers;
};

const commentText = (text: string) => text.replaceAll("*/", "*\\/");

const docComment = (lines: string[], indent: string) => {
  const body = lines.flatMap((line) => commentText(line).split("\n"));

  while (body.at(-1) === "") body.pop();

  if (!body.length) return "";

  return `${indent}/**\n${body.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
};

const commentLines = (comment: Comment) => [
  ...(comment.summary ? [comment.summary, ""] : []),
  ...(comment.remarks ? ["@remarks", comment.remarks, ""] : []),
  ...comment.examples.flatMap((example) => ["@example", example, ""]),
  ...(comment.deprecated === undefined
    ? []
    : [comment.deprecated ? `@deprecated ${comment.deprecated}` : "@deprecated"]),
];

const fieldComment = /\n\/\*\* ((?:(?!\*\/)[\s\S])*?): ((?:(?!\*\/)[\s\S])*) \*\/$/;

/**
 * Splits a definition into its type text and the field descriptions the extractor appends as
 * `/** field: description *\/` comments.
 */
const definitionParts = (definition: string) => {
  const fields: { name: string; description: string }[] = [];
  let type = definition;

  for (let match = fieldComment.exec(type); match; match = fieldComment.exec(type)) {
    fields.unshift({ name: match[1] ?? "", description: match[2] ?? "" });
    type = type.slice(0, match.index);
  }

  return { type, fields };
};

// Whether type text is one object literal type, not, for example, a union of them.
const objectLiteral = (type: string) => {
  if (!type.startsWith("{")) return false;
  let depth = 0;
  let quoted: string | null = null;

  for (let index = 0; index < type.length; index += 1) {
    const char = type[index];

    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === quoted) quoted = null;
    } else if (char === '"' || char === "'" || char === "`") quoted = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index === type.trimEnd().length - 1;
  }

  return false;
};

const escapeExpression = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Moves field descriptions onto their members when the definition is one object literal, as
 * the checker prints it with four spaces per level. Descriptions without a matching member stay
 * behind the definition.
 */
const placeFieldComments = (type: string, fields: { name: string; description: string }[]) => {
  let placed = type;
  const remaining: string[] = [];
  const members = objectLiteral(type);

  for (const field of fields) {
    const member = new RegExp(
      `^( {4})((?:readonly )?(?:${escapeExpression(field.name)}|"${escapeExpression(field.name)}")\\??[:(<])`,
      "m",
    );

    if (members && member.test(placed))
      placed = placed.replace(
        member,
        (_line, indent: string, rest: string) =>
          `${docComment([field.description], indent).trimEnd()}\n${indent}${rest}`,
      );
    else remaining.push(`/** ${field.name}: ${commentText(field.description)} */`);
  }

  return remaining.length ? `${placed}\n${remaining.join("\n")}` : placed;
};

// Globals a binding's members name themselves, which neither the binding nor a documented type
// may shadow.
const requiredGlobals = ["Promise", "globalThis"];

// Words that cannot name the binding's interface and namespace: reserved words, including those
// of strict mode and modules, built-in type names and type operators.
const reservedNames = new Set(
  [
    "break case catch class const continue debugger default delete do else enum export extends",
    "false finally for function if import in instanceof new null return super switch this throw",
    "true try typeof var void while with implements interface let package private protected",
    "public static yield await any unknown never number bigint boolean string symbol object",
    "undefined infer keyof readonly unique",
  ].flatMap((words) => words.split(" ")),
);

// `entrypoint`: the entrypoint is not documented. `name`: a name the declarations need is taken.
const failure = (reason: "entrypoint" | "name", message: string) => ({
  declarations: null,
  failure: { reason, message },
});

export type ServiceBindingTypesOptions = {
  /** The app's slug, as the regeneration command names it. */
  app: string;
  entrypoint: string;
  /** The binding's name in the caller's environment, which names the generated interface. */
  binding: string;
};

/**
 * TypeScript declarations for a caller's binding to an app API, generated from the API's
 * documentation. The binding is a plain interface with the entrypoint's methods, so recursive
 * types stay within the compiler's instantiation limits. Results are what callers receive:
 * a question's `requestState` arrives sealed as a string, and `withInput` retries a call with
 * answers. References the documentation does not declare become `unknown` with the original text
 * in a comment and are listed in the header. Returns why when the entrypoint is not documented or
 * a name the declarations need is taken.
 */
export const serviceBindingTypes = (
  documentation: Documentation,
  { app, entrypoint, binding }: ServiceBindingTypesOptions,
) => {
  if (
    !validIdentifier.test(binding) ||
    reservedNames.has(binding) ||
    requiredGlobals.includes(binding)
  )
    return failure(
      "name",
      `${binding} cannot name a TypeScript interface; choose another binding name`,
    );
  const entry = documentation.entrypoints.find((candidate) => candidate.name === entrypoint);

  if (!entry) return failure("entrypoint", `${entrypoint} is not a documented entrypoint`);

  const identifiers = declarationIdentifiers(
    documentation.types.map((type) => declarationName(type.name)),
  );

  const declared = new Set(identifiers.values());

  for (const name of [binding, ...requiredGlobals])
    if (declared.has(name))
      return failure(
        "name",
        name === binding
          ? `The API documents a type named ${name}; choose another binding name`
          : `The API documents a type named ${name}, which the binding's methods need`,
      );
  const unresolved = new Set<string>();

  const text = (value: string) =>
    rewriteTypeReferences(
      value,
      (reference) => {
        const identifier = identifiers.get(reference);

        if (identifier !== undefined) return identifier;

        if (!reference.startsWith("import(")) return undefined;
        unresolved.add(reference);

        return null;
      },
      { names: true },
    );

  const typeParameters = (parameters: string[] | undefined) =>
    parameters?.length ? `<${parameters.map(text).join(", ")}>` : "";

  const methods = entry.methods.flatMap((method) =>
    method.signatures.map((signature) => {
      const lines = [
        ...commentLines(method),
        ...signature.parameters.flatMap((parameter) =>
          parameter.description ? [`@param ${parameter.name} - ${parameter.description}`] : [],
        ),
        ...(signature.returns.description ? [`@returns ${signature.returns.description}`] : []),
        ...method.throws.map((thrown) => `@throws ${thrown}`),
      ];

      const parameters = signature.parameters
        .map(
          (parameter) =>
            `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional && !parameter.rest ? "?" : ""}: ${text(parameter.type)}`,
        )
        .join(", ");

      // The extractor writes every result as `Promise<Awaited>`, since RPC calls always resolve.
      const returned = /^Promise<([\s\S]*)>$/.exec(signature.returns.type)?.[1];
      const result = text(returned ?? signature.returns.type);

      return `${docComment(lines, "  ")}  ${method.name}${typeParameters(signature.typeParameters)}(${parameters}): Promise<${binding}.Result<${result}>>;\n`;
    }),
  );

  const types = documentation.types
    .map((type) => {
      const name = identifiers.get(declarationName(type.name)) ?? type.name;
      const { type: definition, fields } = definitionParts(type.definition);
      const body = placeFieldComments(text(definition), fields);
      const parameters = typeParameters(type.typeParameters);

      const declaration =
        type.kind === "interface" && body.startsWith("{")
          ? `export interface ${name}${parameters} ${body}`
          : `export type ${name}${parameters} = ${body};`;

      return { name, source: `${docComment(commentLines(type), "")}${declaration}` };
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((type) => type.source);

  const command = [
    "widefleet services types",
    app,
    ...(entrypoint === "default" ? [] : ["--entrypoint", entrypoint]),
    "--as",
    binding,
  ].join(" ");

  const header = [
    `// Generated by \`${command}\` from the API documentation of the app's active deployment.`,
    "// Do not edit; run the command again after the app changes its API.",
    ...(unresolved.size
      ? [
          "// The documentation does not declare these types; they are `unknown` here:",
          ...[...unresolved].sort().map((reference) => `// - ${reference}`),
        ]
      : []),
  ];

  const members = [
    ...methods,
    ...(entry.http
      ? [
          "  /** Sends an HTTP request to the app's entrypoint. */\n  fetch: typeof globalThis.fetch;\n",
        ]
      : []),
    `  /** Calls a method again with the answers to the questions its result asked. */\n  withInput(answer: ${binding}.Answer): ${binding}.Methods;\n`,
  ];

  const declarations = `${[
    header.join("\n"),
    `${docComment(commentLines(entry), "")}export interface ${binding} {\n${members.join("\n")}}`,
    `export declare namespace ${binding} {
  /** The binding's methods, as \`withInput\` returns them. */
  type Methods = { [K in keyof ${binding} as K extends "fetch" | "withInput" ? never : K]: ${binding}[K] };

  /**
   * The answers to a question, by request name, and the \`requestState\` its result carried. An
   * answer is JSON, usually in the shape of an MCP elicitation result, such as
   * \`{ action: "accept", content: { note: "…" } }\`.
   */
  type Answer = { inputResponses: { [request: string]: unknown }; requestState: string };

  /** A method's result as the caller receives it: a question's state arrives sealed. */
  type Result<R> = R extends { resultType: "input_required" }
    ? { [K in keyof R as K extends "requestState" ? never : K]: R[K] } & { requestState: string }
    : R;
}`,
    ...types,
  ].join("\n\n")}`;

  return { declarations, failure: null };
};
