import MarkdownIt from "markdown-it";
import type { serviceDocumentation } from "@platform/contracts";
import type { z } from "zod";

export function renderServiceDocumentation(documentation: z.infer<typeof serviceDocumentation>) {
  const sections: string[] = [];

  for (const entry of documentation.entrypoints) {
    sections.push(`## ${entry.name}`, entry.summary, entry.remarks);

    if (entry.deprecated) sections.push(`Deprecated: ${entry.deprecated}`);

    if (entry.http) sections.push("Supports HTTP through `fetch()`.");
    sections.push(...entry.examples);

    for (const method of entry.methods) {
      sections.push(`### ${method.name}`, method.summary);

      if (method.deprecated) sections.push(`Deprecated: ${method.deprecated}`);

      for (const signature of method.signatures) {
        const parameters = signature.parameters.map(
          (param) =>
            `${param.rest ? "..." : ""}${param.name}${param.optional ? "?" : ""}: ${param.type}`,
        );

        sections.push(
          `\`\`\`ts\n${method.name}(${parameters.join(", ")}): ${signature.returns.type}\n\`\`\``,
        );

        for (const parameter of signature.parameters)
          if (parameter.description)
            sections.push(`**${parameter.name}:** ${parameter.description}`);

        if (signature.returns.description)
          sections.push(`**Returns:** ${signature.returns.description}`);
      }

      sections.push(method.remarks);

      for (const error of method.throws) sections.push(`**Throws:** ${error}`);

      for (const example of method.examples) sections.push("**Example**", example);
    }
  }

  for (const type of documentation.types)
    sections.push(
      `## ${type.name}`,
      type.summary,
      type.remarks,
      `\`\`\`ts\n${type.definition}\n\`\`\``,
    );

  return new MarkdownIt({ html: false }).render(sections.join("\n\n"));
}
