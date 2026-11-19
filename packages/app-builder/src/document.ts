// Documents a bundle's service entrypoints with the service documentation
// module. Declarations are installed separately from the bundle's packages, so
// each phase holds only the files it reads.
import { InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler";
import { documentResult, type documentRequest } from "@platform/contracts/builds";
import { DocumentationError, documentServices } from "@platform/service-docs";
import { z } from "zod";
import serviceDocs from "./service-docs.wasm";
import { BuildError, parseJson } from "./configuration.ts";

const manifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

// Type packages and shared tsconfig bases are development dependencies.
const declarationPackage = (name: string) =>
  name.startsWith("@types/") ||
  name.startsWith("@tsconfig/") ||
  name === "@cloudflare/workers-types";

const project = "/project";

export const document = async (request: z.infer<typeof documentRequest>, registry: string) => {
  const packages = manifest.parse(parseJson(request.files["package.json"] ?? "{}", "package.json"));

  const declarations = new InMemoryFileSystem({
    "package.json": JSON.stringify({
      dependencies: {
        ...packages.dependencies,
        ...Object.fromEntries(
          Object.entries(packages.devDependencies).filter(([name]) => declarationPackage(name)),
        ),
      },
    }),
  });

  await installDependencies(declarations, { files: "declarations", registry });

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

    return documentResult.parse({ documentation });
  } catch (error) {
    if (error instanceof DocumentationError) throw new BuildError(error.message);

    throw error;
  }
};
