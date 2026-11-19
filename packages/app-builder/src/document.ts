// Documents a bundle's service entrypoints with the service documentation
// module. Declarations are installed separately from the bundle's packages, so
// each phase holds only the files it reads.
import { InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler";
import { documentResult, type documentRequest } from "@platform/contracts/builds";
import { DocumentationError, documentServices } from "@platform/service-docs";
import { z } from "zod";
import serviceDocs from "./service-docs.wasm";
import { BuildError, parseJson, parseJsonc } from "./configuration.ts";

const manifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

const tsconfig = z.looseObject({
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  compilerOptions: z.looseObject({ types: z.array(z.string()).optional() }).optional(),
});

const sourceFile = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

const specifierPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|<reference\s+types\s*=\s*)["']([^"']+)["']/g;

const project = "/project";

// The package a bare specifier or tsconfig reference names, if any.
const packageName = (specifier: string) => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":"))
    return undefined;

  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

// The DefinitelyTyped package for a package name.
const typesPackage = (name: string) =>
  `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

/**
 * Development dependencies the type checker can read: packages the sources or
 * tsconfig.json reference, their `@types` packages, type packages and shared
 * tsconfig bases. Type-only imports are erased from the bundle, so the
 * bundle's dependencies alone do not cover them.
 */
const developmentDeclarations = (
  files: Readonly<Record<string, string>>,
  developmentDependencies: Readonly<Record<string, string>>,
) => {
  const referenced = new Set<string>();

  const reference = (specifier: string) => {
    const name = packageName(specifier);

    if (name) referenced.add(name).add(typesPackage(name));
  };

  for (const [path, content] of Object.entries(files)) {
    if (!sourceFile.test(path)) continue;

    for (const match of content.matchAll(specifierPattern)) if (match[1]) reference(match[1]);
  }

  const configuration = tsconfig.safeParse(
    parseJsonc(files["tsconfig.json"] ?? "{}", "tsconfig.json"),
  );

  if (configuration.success) {
    const bases = configuration.data.extends ?? [];

    for (const base of Array.isArray(bases) ? bases : [bases]) reference(base);

    for (const type of configuration.data.compilerOptions?.types ?? []) reference(type);
  }

  return Object.fromEntries(
    Object.entries(developmentDependencies).filter(
      ([name]) =>
        referenced.has(name) ||
        name.startsWith("@types/") ||
        name.startsWith("@tsconfig/") ||
        name === "@cloudflare/workers-types",
    ),
  );
};

export const document = async (request: z.infer<typeof documentRequest>, registry: string) => {
  const packages = manifest.parse(parseJson(request.files["package.json"] ?? "{}", "package.json"));

  const declarations = new InMemoryFileSystem({
    "package.json": JSON.stringify({
      dependencies: {
        ...packages.dependencies,
        ...developmentDeclarations(request.files, packages.devDependencies),
      },
    }),
  });

  const installed = await installDependencies(declarations, { files: "declarations", registry });
  const files = new Map<string, string>();

  for (const path of declarations.list()) {
    const content = declarations.read(path);

    if (content !== null && path !== "package.json") files.set(`${project}/${path}`, content);
  }

  for (const [path, content] of Object.entries(request.files))
    files.set(`${project}/${path}`, content);

  files.set(`${project}/worker.js`, request.worker);
  files.set(`${project}/worker.js.map`, request.map);

  try {
    const { documentation } = documentServices(serviceDocs, {
      project,
      bundle: `${project}/worker.js`,
      map: `${project}/worker.js.map`,
      entry: `${project}/${request.entry}`,
      entrypoints: request.entrypoints,
      files,
    });

    return documentResult.parse({ documentation, warnings: installed.warnings });
  } catch (error) {
    if (error instanceof DocumentationError) throw new BuildError(error.message);

    throw error;
  }
};
