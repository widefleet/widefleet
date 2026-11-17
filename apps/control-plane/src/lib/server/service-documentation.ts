import MarkdownIt from "markdown-it";
import type { serviceDocumentation } from "@platform/contracts";
import type { z } from "zod";

// Type references from extracted declarations carry module paths that callers never import.
const typeName = (type: string) => type.replaceAll(/import\("[^"]*"\)\./g, "");

export function presentServiceDocumentation(documentation: z.infer<typeof serviceDocumentation>) {
  const markdown = new MarkdownIt({ html: false });

  const render = (...parts: (string | undefined)[]) => {
    const source = parts.filter(Boolean).join("\n\n");

    return source ? markdown.render(source) : null;
  };

  const inline = (source: string) => markdown.renderInline(source);

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
            ? `<${signature.typeParameters.join(", ")}>`
            : "";

          const parameters = signature.parameters.map(
            (param) =>
              `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}: ${typeName(param.type)}`,
          );

          return {
            code: `${method.name}${typeParameters}(${parameters.join(", ")}): ${typeName(signature.returns.type)}`,
            parameters: signature.parameters.map((param) => ({
              name: `${param.name}${param.optional ? "?" : ""}`,
              type: typeName(param.type),
              description: param.description ? inline(param.description) : null,
            })),
            returns: {
              type: typeName(signature.returns.type),
              description: signature.returns.description
                ? inline(signature.returns.description)
                : null,
            },
          };
        }),
        remarks: render(method.remarks),
        throws: method.throws.map(inline),
        examples: render(...method.examples),
      })),
    })),
    types: documentation.types.map((type) => ({
      name: typeName(type.name),
      description: render(
        type.summary,
        type.remarks,
        type.deprecated && `Deprecated: ${type.deprecated}`,
      ),
      definition: typeName(type.definition),
      examples: render(...type.examples),
    })),
  };
}
