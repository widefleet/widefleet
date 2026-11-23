// Garmin publishes the Personal API's OpenAPI description only inside the
// script of its Swagger page, as the string a `JSON.parse('...')` call reads.
// `download` finds that script through the page, reads the string literal and
// decodes its escapes. It never runs Garmin's script.

/** The official Swagger page of the Garmin Connect Personal API. */
export const swaggerPage =
  "https://developer.garmin.com/gc-developer-program/personal/swagger-docs/";

// The script the page loads; its name carries a hash that changes with each build.
const scriptPath = /\/component---src-pages-gc-developer-program-personal-swagger-docs-js-\w+\.js/;

const text = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);

  return response.text();
};

const escapes = new Map([
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["0", "\0"],
]);

/** The value of the single-quoted JavaScript string that starts at `start`. */
const stringLiteral = (code: string, start: number) => {
  let end = start + 1;

  while (end < code.length && code[end] !== "'") end += code[end] === "\\" ? 2 : 1;

  if (end >= code.length) throw new Error("The string does not end");

  return code
    .slice(start + 1, end)
    .replace(
      /\\(?:x([\da-fA-F]{2})|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|(\r\n|[\s\S]))/g,
      (_, byte?: string, point?: string, unit?: string, other?: string) => {
        const hex = byte ?? point ?? unit;

        if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));

        // A backslash before a line break continues the line.
        if (other === undefined || /^(?:\r\n|[\r\n\u2028\u2029])$/.test(other)) return "";

        return escapes.get(other) ?? other;
      },
    );
};

/** The current OpenAPI description, as JSON text. */
export const download = async () => {
  const page = await text(swaggerPage);
  const script = scriptPath.exec(page)?.[0];

  if (!script) throw new Error("Garmin's Swagger page no longer names its script");

  const code = await text(new URL(script, swaggerPage).href);
  const call = code.indexOf(`JSON.parse('{"openapi":`);

  if (call < 0) throw new Error("Garmin's Swagger script no longer holds the description");

  return stringLiteral(code, call + "JSON.parse(".length);
};
