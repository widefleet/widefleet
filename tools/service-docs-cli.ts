import { extractServiceDocumentation } from "./service-docs.ts";

try {
  const [project, bundle, ...entrypoints] = process.argv.slice(2);

  if (!project || !bundle) throw new Error("Expected project and bundled Worker paths");
  const result = extractServiceDocumentation(project, bundle, entrypoints);

  for (const warning of result.warnings) console.error(`API documentation: ${warning}`);
  console.info(JSON.stringify(result.documentation));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not extract service documentation");
  process.exitCode = 1;
}
