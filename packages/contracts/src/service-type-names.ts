import type { z } from "zod";
import type { serviceDocumentation } from "./service-documentation.ts";

const typeReference = /import\("(?:[^"\\]|\\.)*"\)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;

const leadingReference = new RegExp(
  `^(?:${typeReference.source}|[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`,
);

const modulePath = /^import\("(?:[^"\\]|\\.)*"\)\./;

/**
 * Extracted declarations qualify types with module paths that callers never import. Map each
 * documented declaration reference to its unqualified name when that name is unambiguous among the
 * documented declarations and keep the qualified name otherwise, so sibling modules exporting the
 * same name stay distinguishable.
 */
const displayNames = (names: readonly string[]) => {
  const references = new Set(names.flatMap((name) => leadingReference.exec(name)?.[0] ?? []));

  const unqualified = (reference: string) => reference.replace(modulePath, "");

  const counts = new Map<string, number>();

  for (const reference of references)
    counts.set(unqualified(reference), (counts.get(unqualified(reference)) ?? 0) + 1);

  return new Map(
    [...references].map((reference) => [
      reference,
      counts.get(unqualified(reference)) === 1 ? unqualified(reference) : reference,
    ]),
  );
};

const identifier = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;

const identifierPart = /[\w$.]/;

/**
 * How {@link rewriteTypeReferences} treats one reference: keep it (`undefined`), replace it with
 * other text, or drop it (`null`), together with its type arguments and a preceding `typeof`, in
 * favor of `unknown`.
 */
export type ReferenceRewrite = string | null | undefined;

/**
 * Rewrites the type references in TypeScript type text: module-qualified references such as
 * `import("./src/api").Issue` and, when `names` is set, unqualified names such as `Issue` or
 * `Page.Item`. String and template literal text and comments are copied unchanged because they
 * describe values, not references. An unresolved reference becomes `unknown` followed by a comment
 * that keeps the original text.
 */
export const rewriteTypeReferences = (
  text: string,
  replace: (reference: string) => ReferenceRewrite,
  { names = false } = {},
) => {
  let index = 0;

  const skipQuoted = () => {
    const quote = text[index];
    const start = index;
    index += 1;

    while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
    index = Math.min(index + 1, text.length);

    return text.slice(start, index);
  };

  const skipUntil = (terminator: string) => {
    const end = text.indexOf(terminator, index);
    const start = index;
    index = end === -1 ? text.length : end + terminator.length;

    return text.slice(start, index);
  };

  // The type arguments that follow a reference, such as `<Item, "a" | "b">`.
  const skipArguments = () => {
    const start = index;
    let depth = 0;

    while (index < text.length) {
      const char = text[index];

      if (char === '"' || char === "'" || char === "`") {
        skipQuoted();
        continue;
      }

      if (char === "<") depth += 1;
      // `=>` in a function type closes nothing.
      else if (char === ">" && text[index - 1] !== "=") depth -= 1;
      index += 1;

      if (depth === 0) break;
    }

    return text.slice(start, index);
  };

  const unresolved = (output: string, reference: string) => {
    const typeOf = /typeof\s+$/.exec(output);
    const prefix = typeOf ? output.slice(0, typeOf.index) : output;
    const original = `${typeOf?.[0] ?? ""}${reference}${text[index] === "<" ? skipArguments() : ""}`;

    return `${prefix}unknown /* ${original.replaceAll("*/", "* /")} */`;
  };

  // The reference at the current position, if any, which the scan then continues after.
  const referenceAt = () => {
    typeReference.lastIndex = index;
    const qualified = typeReference.exec(text);

    if (qualified) {
      index = typeReference.lastIndex;

      return qualified[0];
    }

    if (!names || identifierPart.test(text[index - 1] ?? "")) return null;
    identifier.lastIndex = index;
    const name = identifier.exec(text);

    if (!name) return null;
    index = identifier.lastIndex;

    return name[0];
  };

  const template = () => {
    let output = "`";
    index += 1;

    while (index < text.length) {
      const char = text[index];

      if (char === "\\") {
        output += text.slice(index, index + 2);
        index += 2;
      } else if (char === "`") {
        index += 1;

        return `${output}\``;
      } else if (text.startsWith("${", index)) {
        index += 2;
        output += `\${${type(true)}}`;
        index += 1;
      } else {
        output += char;
        index += 1;
      }
    }

    return output;
  };

  const type = (embedded: boolean): string => {
    let output = "";
    let depth = 0;

    while (index < text.length) {
      const char = text[index];

      if (embedded && char === "}" && depth === 0) return output;
      const reference = referenceAt();

      if (reference) {
        const rewrite = replace(reference);

        if (rewrite === null) output = unresolved(output, reference);
        else output += rewrite ?? reference;
      } else if (char === '"' || char === "'") output += skipQuoted();
      else if (char === "`") output += template();
      else if (text.startsWith("/*", index)) output += skipUntil("*/");
      else if (text.startsWith("//", index)) output += skipUntil("\n");
      else {
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
        output += char;
        index += 1;
      }
    }

    return output;
  };

  return type(false);
};

type Documentation = z.infer<typeof serviceDocumentation>;

/**
 * Documentation with the module paths of its type references removed where the name stays
 * unambiguous, such as `Issue` for `import("./src/api").Issue`. Names, definitions, signatures and
 * uses change together, so every name still refers to its declaration. Applying it twice changes
 * nothing.
 */
export const shortenTypeNames = (documentation: Documentation): Documentation => {
  const names = displayNames(documentation.types.map((type) => type.name));
  const text = (value: string) => rewriteTypeReferences(value, (reference) => names.get(reference));

  return {
    ...documentation,
    entrypoints: documentation.entrypoints.map((entry) => ({
      ...entry,
      methods: entry.methods.map((method) => ({
        ...method,
        signatures: method.signatures.map((signature) => ({
          ...signature,
          ...(signature.typeParameters && { typeParameters: signature.typeParameters.map(text) }),
          parameters: signature.parameters.map((parameter) => ({
            ...parameter,
            type: text(parameter.type),
          })),
          returns: { ...signature.returns, type: text(signature.returns.type) },
          uses: signature.uses.map(text),
        })),
      })),
    })),
    types: documentation.types.map((type) => ({
      ...type,
      name: text(type.name),
      ...(type.typeParameters && { typeParameters: type.typeParameters.map(text) }),
      definition: text(type.definition),
      uses: type.uses.map(text),
    })),
  };
};
