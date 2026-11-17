import MarkdownIt from "markdown-it";
import type { serviceDocumentation } from "@platform/contracts";
import type { z } from "zod";

const qualifiedName = /^import\("(?:[^"\\]|\\.)*"\)\.(.+)$/;

const typeReference = /import\("(?:[^"\\]|\\.)*"\)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;

/**
 * Extracted declarations qualify types with module paths that callers never import. Show the
 * unqualified name when it is unambiguous among the documented types and keep the qualified name
 * otherwise, so sibling modules exporting the same name stay distinguishable.
 */
const displayNames = (names: readonly string[]) => {
  const unqualified = (name: string) => qualifiedName.exec(name)?.[1] ?? name;

  const counts = new Map<string, number>();

  for (const name of names) counts.set(unqualified(name), (counts.get(unqualified(name)) ?? 0) + 1);

  return new Map(
    names.map((name) => [name, counts.get(unqualified(name)) === 1 ? unqualified(name) : name]),
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

export function presentServiceDocumentation(documentation: z.infer<typeof serviceDocumentation>) {
  const markdown = new MarkdownIt({ html: false });

  const names = displayNames(documentation.types.map((type) => type.name));

  const typeText = (text: string) => rewriteReferences(text, names);

  const render = (...parts: (string | undefined)[]) => {
    const source = parts.filter(Boolean).join("\n\n");

    return source ? markdown.render(source) : null;
  };

  return {
    entrypoints: documentation.entrypoints.map((entry) => ({
      name: entry.name,
      http: entry.http,
      description: render(
        entry.summary,
        entry.remarks,
        entry.deprecated && `Deprecated: ${entry.deprecated}`,
        ...entry.examples,
      ),
      methods: entry.methods.map((method) => ({
        name: method.name,
        summary: render(method.summary, method.deprecated && `Deprecated: ${method.deprecated}`),
        signatures: method.signatures.map((signature) => {
          const typeParameters = signature.typeParameters?.length
            ? `<${signature.typeParameters.map(typeText).join(", ")}>`
            : "";

          const parameters = signature.parameters.map(
            (param) =>
              `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}: ${typeText(param.type)}`,
          );

          return {
            code: `${method.name}${typeParameters}(${parameters.join(", ")}): ${typeText(signature.returns.type)}`,
            parameters: signature.parameters.map((param) => ({
              name: `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}`,
              type: typeText(param.type),
              description: render(param.description),
            })),
            returns: {
              type: typeText(signature.returns.type),
              description: render(signature.returns.description),
            },
          };
        }),
        remarks: render(method.remarks),
        throws: method.throws.map((error) => markdown.render(`Throws: ${error}`)),
        examples: render(...method.examples),
      })),
    })),
    types: documentation.types.map((type) => ({
      name: names.get(type.name) ?? type.name,
      description: render(
        type.summary,
        type.remarks,
        type.deprecated && `Deprecated: ${type.deprecated}`,
      ),
      definition: typeText(type.definition),
      examples: render(...type.examples),
    })),
  };
}
