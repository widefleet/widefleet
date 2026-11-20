import { z } from "zod";

// JSONC as Wrangler accepts it: line and block comments and trailing commas.
export const stripJsonc = (text: string) => {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);

    if (character === '"') {
      const start = index;
      index++;

      while (index < text.length && text.charAt(index) !== '"')
        index += text.charAt(index) === "\\" ? 2 : 1;
      output += text.slice(start, index + 1);
      index++;
    } else if (character === "/" && next === "/") {
      while (index < text.length && text.charAt(index) !== "\n") index++;
    } else if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      // A comma before a closing bracket, outside strings, is a trailing comma.
      if (character === "}" || character === "]") output = output.replace(/,(\s*)$/, "$1");
      output += character;
      index++;
    }
  }

  return output;
};

/** Parses JSONC as Wrangler accepts it. Invalid input throws a SyntaxError. */
export const parseJsonc = (text: string) => z.json().parse(JSON.parse(stripJsonc(text)));
