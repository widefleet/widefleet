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

/**
 * Replaces documented type references in TypeScript type text. String and template literal text and
 * comments are copied unchanged because they describe values, not references.
 */
const rewriteReferences = (text: string, names: ReadonlyMap<string, string>) => {
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
      typeReference.lastIndex = index;
      const reference = typeReference.exec(text);

      if (reference) {
        output += names.get(reference[0]) ?? reference[0];
        index = typeReference.lastIndex;
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
  const text = (value: string) => rewriteReferences(value, names);

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
