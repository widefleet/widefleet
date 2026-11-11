import { DocExcerpt, TSDocParser, type DocNode } from "@microsoft/tsdoc";
import ts from "typescript";

const parser = new TSDocParser();

function text(node: DocNode): string {
  if (node instanceof DocExcerpt) return node.content.toString();

  return node.getChildNodes().map(text).join("");
}

export function documentation(node: ts.Node | undefined, warnings: string[]) {
  const raw = node && ts.getJSDocCommentsAndTags(node).find(ts.isJSDoc)?.getText();
  const parsed = parser.parseString(raw ?? "/** */");

  if (node)
    for (const message of parsed.log.messages)
      warnings.push(`${node.getSourceFile().fileName}: ${message.unformattedText}`);

  const doc = parsed.docComment;

  const blocks = (tag: string) =>
    doc.customBlocks
      .filter((block) => block.blockTag.tagName === tag)
      .map((block) => text(block.content).trim());

  return {
    comment: {
      summary: text(doc.summarySection).trim(),
      remarks: doc.remarksBlock ? text(doc.remarksBlock.content).trim() : "",
      examples: blocks("@example"),
      deprecated: doc.deprecatedBlock ? text(doc.deprecatedBlock.content).trim() : undefined,
    },
    parameters: new Map(
      [...doc.params].map((param) => [param.parameterName, text(param.content).trim()]),
    ),
    returns: doc.returnsBlock ? text(doc.returnsBlock.content).trim() : "",
    throws: blocks("@throws"),
  };
}
