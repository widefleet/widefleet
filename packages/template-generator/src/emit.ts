/** A TSDoc comment, or nothing for empty text. */
export const comment = (text: string | null | undefined, indent = "") =>
  text
    ? `${indent}/**\n${text
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
