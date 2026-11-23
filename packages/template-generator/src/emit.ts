/** A TSDoc comment, or nothing for empty text. */
export const comment = (text: string | null | undefined, indent = "") =>
  text
    ? `${indent}/**\n${text
        // Descriptions may carry non-breaking and other unusual spaces.
        .replace(/[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/g, " ")
        .replaceAll("*/", "*\\/")
        .split("\n")
        .map((line) => `${indent} *${line ? ` ${line}` : ""}`)
        .join("\n")}\n${indent} */\n`
    : "";

/** A type name as TypeScript accepts it. */
export const identifier = (name: string) => name.replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1");

/** A property name, quoted when it is not an identifier. */
export const propertyName = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);

/**
 * Names the generated api.ts imports. The template's own `Environment` is
 * imported as `TemplateEnvironment`, since APIs have types of that name.
 */
export const importedNames = (service: { result: string; properties: string }) => [
  "WorkerEntrypoint",
  "TemplateEnvironment",
  service.result,
  service.properties,
  "run",
  "Exact",
  "JsonObject",
  "JsonValue",
  "Selection",
  "ValueResult",
  "Variants",
];

/** Stops when a type of the API would shadow a name the generated file imports. */
export const checkTypeNames = (
  names: readonly string[],
  service: { result: string; properties: string },
) => {
  const imported = new Set(importedNames(service));
  const clashes = names.filter((name) => imported.has(name));

  if (clashes.length)
    throw new Error(
      `The API's types ${clashes.join(", ")} have the names of imports of the generated file`,
    );
};
