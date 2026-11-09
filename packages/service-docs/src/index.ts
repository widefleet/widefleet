import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  Application,
  Converter,
  ReflectionKind,
  ReflectionType,
  makeRecursiveVisitor,
  type Comment,
  type CommentDisplayPart,
  type DeclarationReflection,
  type SomeType,
} from "typedoc";
import { serviceDocumentation } from "@platform/contracts";

const text = (parts: CommentDisplayPart[] | undefined) =>
  parts?.map((part) => part.text).join("") ?? "";

const comment = (value: Comment | undefined) => ({
  description: [
    text(value?.summary),
    ...(value?.blockTags.filter((tag) => tag.tag === "@remarks").map((tag) => text(tag.content)) ??
      []),
  ]
    .filter(Boolean)
    .join("\n\n"),
  examples:
    value?.blockTags.filter((tag) => tag.tag === "@example").map((tag) => text(tag.content)) ?? [],
});

const handlers = new Set([
  "constructor",
  "fetch",
  "connect",
  "scheduled",
  "queue",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

export const generateServiceDocumentation = async (
  entry: string,
  tsconfig = "tsconfig.json",
  directory = process.cwd(),
) => {
  const root = resolve(directory);
  const source = resolve(root, entry);
  const inputs = new Map<string, string>();

  const app = await Application.bootstrap({
    entryPoints: [source],
    tsconfig: resolve(root, tsconfig),
    excludePrivate: true,
    excludeProtected: true,
    excludeExternals: true,
    excludeInternal: true,
    disableSources: true,
  });

  app.converter.on(Converter.EVENT_BEGIN, (context) => {
    for (const program of context.programs)
      for (const file of program.getSourceFiles())
        inputs.set(
          relative(root, file.fileName).replaceAll("\\", "/"),
          createHash("sha256").update(file.text).digest("hex"),
        );
  });

  const project = await app.convert();

  if (!project || app.logger.hasErrors())
    throw new Error("Could not generate service documentation");
  inputs.set(
    relative(root, resolve(root, tsconfig)).replaceAll("\\", "/"),
    createHash("sha256")
      .update(await readFile(resolve(root, tsconfig)))
      .digest("hex"),
  );

  const definitions = (entrypoint: DeclarationReflection) => {
    const named = new Map<string, string>();
    const seen = new Set<number>();

    const visit = (type: SomeType | undefined) =>
      type?.visit(
        makeRecursiveVisitor({
          reference: (reference) => {
            const reflection = reference.reflection;

            if (
              !reflection?.isDeclaration() ||
              seen.has(reflection.id) ||
              reflection.flags.isExternal
            )
              return;
            seen.add(reflection.id);
            named.set(
              reference.name,
              reflection.type?.toString() ?? new ReflectionType(reflection).toString(),
            );
            visit(reflection.type);

            for (const child of reflection.children ?? []) visit(child.type);
          },
        }),
      );

    for (const method of entrypoint.children ?? []) {
      for (const signature of method.signatures ?? []) {
        visit(signature.type);

        for (const parameter of signature.parameters ?? []) visit(parameter.type);
      }
    }

    return Object.fromEntries(named);
  };

  const documentation = serviceDocumentation.parse(
    Object.fromEntries(
      (project.children ?? []).flatMap((candidate) => {
        const entrypoint = candidate.isReference()
          ? candidate.tryGetTargetReflectionDeep()
          : candidate;

        if (!entrypoint?.isDeclaration() || !entrypoint.kindOf(ReflectionKind.Class)) return [];

        const methods = (entrypoint.children ?? []).flatMap((method) => {
          if (
            !method.kindOf(ReflectionKind.Method) ||
            method.flags.isStatic ||
            method.flags.isPrivate ||
            method.flags.isProtected ||
            handlers.has(method.name) ||
            method.name.startsWith("WIDEFLEET_")
          )
            return [];

          return (method.signatures ?? []).map((signature) => {
            const parameters = (signature.parameters ?? []).map((parameter) => ({
              name: parameter.name,
              type: parameter.type?.toString() ?? "unknown",
              optional: parameter.flags.isOptional || parameter.defaultValue !== undefined,
              rest: parameter.flags.isRest,
              description: text(parameter.comment?.summary),
            }));

            const returns = signature.type?.toString() ?? "unknown";

            return {
              name: method.name,
              ...comment(signature.comment ?? method.comment),
              parameters,
              returns,
              signature: `${method.name}(${parameters.map((parameter) => `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}`).join(", ")}): ${returns}`,
            };
          });
        });

        return [
          [
            candidate.name,
            { ...comment(entrypoint.comment), methods, types: definitions(entrypoint) },
          ],
        ];
      }),
    ),
  );

  return {
    entry: relative(root, source).replaceAll("\\", "/"),
    inputs: Object.fromEntries(inputs),
    documentation,
  };
};
