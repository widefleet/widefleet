import MarkdownIt from "markdown-it";
import type { serviceDocumentation } from "@platform/contracts";
import type { z } from "zod";

export function presentServiceDocumentation(documentation: z.infer<typeof serviceDocumentation>) {
  const markdown = new MarkdownIt({ html: false });

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
            ? `<${signature.typeParameters.join(", ")}>`
            : "";

          const parameters = signature.parameters.map(
            (param) =>
              `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}: ${param.type}`,
          );

          return {
            code: `${method.name}${typeParameters}(${parameters.join(", ")}): ${signature.returns.type}`,
            parameters: signature.parameters.map((param) => ({
              name: `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}`,
              type: param.type,
              description: render(param.description),
            })),
            returns: {
              type: signature.returns.type,
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
      name: type.name,
      description: render(
        type.summary,
        type.remarks,
        type.deprecated && `Deprecated: ${type.deprecated}`,
      ),
      definition: type.definition,
      examples: render(...type.examples),
    })),
  };
}
