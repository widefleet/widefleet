// Brings the schemas a description refers to in other files into the
// description, so the generator reads one document. Strava's Swagger
// description keeps its schemas in sibling files, such as
// `activity.json#/DetailedActivity`, which refer to each other.
import { z } from "zod";
import { type Json, jsonEntries, jsonObject, type JsonObject } from "./rules.ts";
import { isSwagger } from "./swagger.ts";

/** Reads a document the description refers to, by its URL. */
export type LoadDocument = (url: string) => Promise<Json>;

// The value a JSON pointer such as `/definitions/Item` names in a document.
const pointed = (document: Json, pointer: string, url: string) =>
  pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<Json>((value, part) => {
      const found = jsonObject.safeParse(value);
      const entry = found.success ? found.data[part] : undefined;

      if (entry === undefined) throw new Error(`${url}#${pointer} is not described`);

      return entry;
    }, document);

// A reference to another file: any reference outside the description itself.
const external = (key: string, entry: Json, inside: boolean) => {
  const ref = z.string().safeParse(entry);

  return key === "$ref" && ref.success && (inside || !ref.data.startsWith("#")) ? ref.data : null;
};

// Whether a value refers to another file anywhere.
const refersOut = (value: Json): boolean => {
  if (Array.isArray(value)) return value.some(refersOut);

  return (
    jsonEntries(value)?.some(
      ([key, entry]) => external(key, entry, false) !== null || refersOut(entry),
    ) ?? false
  );
};

/**
 * The description with every schema it refers to in other files added under
 * the schema's name, as Swagger's definitions or OpenAPI's component schemas,
 * and the references pointing there. References inside a referred file resolve
 * against that file. Two schemas with the same name stop the generator.
 */
export const bundleReferences = async (
  description: Json,
  url: string,
  load: LoadDocument,
): Promise<Json> => {
  // Most descriptions are one file; large ones, such as Microsoft Graph's, stay as they are.
  if (!refersOut(description)) return description;
  const root = jsonObject.parse(description);
  const swagger = isSwagger(root);
  const local = swagger ? "#/definitions/" : "#/components/schemas/";

  const schemasOf = (value: JsonObject) =>
    jsonObject.parse(
      (swagger
        ? value["definitions"]
        : jsonObject.optional().parse(value["components"])?.["schemas"]) ?? {},
    );

  const own = schemasOf(root);
  const added: JsonObject = {};
  // The address each added name stands for.
  const names = new Map<string, string>();
  // The description itself, which referred files may point back into.
  const home = new URL(url);
  home.hash = "";
  const documents = new Map<string, Promise<Json>>([[home.href, Promise.resolve(description)]]);

  const document = (address: string) => {
    const known = documents.get(address);

    if (known) return known;
    const loaded = load(address);
    documents.set(address, loaded);

    return loaded;
  };

  const resolve = async (ref: string, base: string) => {
    const target = new URL(ref, base);
    const pointer = decodeURIComponent(target.hash.slice(1));
    target.hash = "";
    const address = `${target.href}#${pointer}`;

    // A reference back to one of the description's own schemas stays local.
    if (target.href === home.href && pointer.startsWith(local.slice(1))) {
      const schema = pointer.slice(local.length - 1);

      if (Object.hasOwn(own, schema)) return `${local}${schema}`;
    }

    // A file that is one schema takes its name from the file, such as `Pet` for `Pet.yaml`.
    const name =
      (pointer
        ? pointer.split("/").at(-1)
        : decodeURIComponent(target.pathname.split("/").at(-1) ?? "").replace(/\.[^.]*$/, "")) ??
      "";

    const taken = names.get(name);

    if (taken === address) return `${local}${name}`;

    if (!name || taken !== undefined || Object.hasOwn(own, name))
      throw new Error(`${address} would take the schema name ${name || "(none)"}, which is taken`);
    names.set(name, address);
    added[name] = await walk(
      pointed(await document(target.href), pointer, target.href),
      target.href,
    );

    return `${local}${name}`;
  };

  // Local references of the description stay; those of a referred file are its own.
  const walk = async (value: Json, base: string | null): Promise<Json> => {
    if (Array.isArray(value)) return Promise.all(value.map((entry) => walk(entry, base)));
    const entries = jsonEntries(value);

    if (!entries) return value;

    return Object.fromEntries(
      await Promise.all(
        entries.map(async ([key, entry]) => {
          const ref = external(key, entry, base !== null);
          const walked = ref === null ? await walk(entry, base) : await resolve(ref, base ?? url);

          return [key, walked] as const;
        }),
      ),
    );
  };

  const bundled = jsonObject.parse(await walk(root, null));
  const schemas = { ...schemasOf(bundled), ...added };

  if (swagger) return { ...bundled, definitions: schemas };

  return {
    ...bundled,
    components: { ...jsonObject.optional().parse(bundled["components"]), schemas },
  };
};
