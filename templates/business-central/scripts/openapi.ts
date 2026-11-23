// Microsoft publishes no OpenAPI description of Business Central's API v2.0.
// Each environment serves the OData metadata of the API pages it runs, but only
// to a signed-in user of that environment. Microsoft publishes the two sources
// that metadata and its reference come from, and `download` builds the
// description from both:
//
// - The AL source of the API pages, in microsoft/BCApps. Business Central
//   serves each API page as an entity set: the page names the set and its
//   entity, the fields it offers, which of them are read-only, whether it
//   allows POST, PATCH and DELETE, its subpages, which become navigation
//   properties, and its bound actions with their captions.
// - The API reference, in MicrosoftDocs/dynamics365smb-devitpro-pb (CC BY 4.0),
//   which lists each entity's properties with their types and descriptions,
//   the entity sets of a company and the environments endpoint.
//
// `download` reads both from their main branches. It never runs AL code; it
// reads the page declarations, field lists and attributes as text.

import { z } from "zod";

/** The API reference the description follows. */
export const reference =
  "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/";

const pagesDirectory = "microsoft/BCApps/contents/src/Apps/W1/APIV2/app/src/pages";

const referenceDirectory =
  "MicrosoftDocs/dynamics365smb-devitpro-pb/contents/dev-itpro/api-reference/v2.0/resources";

const environmentsPage =
  "https://raw.githubusercontent.com/MicrosoftDocs/dynamics365smb-devitpro-pb/main/dev-itpro/webservices/api-get-environments.md";

/** An OpenAPI schema, as far as this description writes them. */
type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  readOnly?: boolean;
  items?: Schema;
  properties?: Record<string, Schema>;
  "x-ms-navigationProperty"?: boolean;
};

type Parameter = {
  name: string;
  in: "path" | "query";
  description: string;
  required?: boolean;
  explode?: boolean;
  schema: Schema;
};

type Operation = {
  operationId: string;
  summary: string;
  description?: string;
  parameters: Parameter[];
  requestBody?: {
    required: true;
    description: string;
    content: { "application/json": { schema: Schema } };
  };
  responses: Record<string, { description: string; content?: Record<string, { schema: Schema }> }>;
  "x-ms-pageable"?: { nextLinkName: string };
};

/** A field of an API page: its name in the API and whether it can be written. */
type Field = { name: string; editable: boolean };

/** A subpage, which Business Central serves as a navigation property. */
type Part = { name: string; page: string; many: boolean };

/** A procedure Business Central serves as a bound action, with its caption. */
type Action = { name: string; caption: string };

/** An API page of the standard API v2.0, as its AL source declares it. */
export type Page = {
  page: string;
  entityName: string;
  entitySetName: string;
  entityCaption: string;
  entitySetCaption: string;
  about: string;
  insert: boolean;
  modify: boolean;
  delete: boolean;
  fields: Field[];
  parts: Part[];
  actions: Action[];
};

/** A property as the API reference lists it. */
type Property = { name: string; type: string; description: string };

/** An entity's page in the API reference. */
export type Reference = {
  summary: string;
  properties: Property[];
  navigation: string[];
};

// AL strings double their quotes.
const alString = (value: string) => value.slice(1, -1).replaceAll("''", "'");

/**
 * AL source with its comments and the contents of its strings blanked, at the
 * same offsets. Declarations, braces and properties are found in it, so text in
 * a comment or a string never counts as code; values are read from the source.
 */
const structure = (source: string) => {
  let masked = "";
  let index = 0;

  const blank = (end: number) => {
    masked += source.slice(index, end).replace(/[^\n]/g, " ");
    index = end;
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "'") {
      // A string ends at a quote that is not doubled.
      let end = index + 1;

      while (end < source.length && (source[end] !== "'" || source[end + 1] === "'"))
        end += source[end] === "'" ? 2 : 1;

      masked += "'";
      index++;
      blank(end);
      masked += source.slice(index, end + 1);
      index = end + 1;
    } else if (character === '"') {
      // Quoted identifiers, such as page and field names, stay as they are.
      const end = source.indexOf('"', index + 1);
      const stop = end < 0 ? source.length : end + 1;

      masked += source.slice(index, stop);
      index = stop;
    } else if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);

      blank(end < 0 ? source.length : end);
    } else if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);

      blank(end < 0 ? source.length : end + 2);
    } else {
      masked += character;
      index++;
    }
  }

  return masked;
};

/** A declaration's body: its offsets in an AL file and the file with its masked form. */
type Body = { source: string; masked: string; start: number; end: number };

// The body from the brace after `from` to its matching brace.
const block = (outer: Body, from: number): Body => {
  const open = outer.masked.indexOf("{", from);

  if (open < 0 || open >= outer.end) throw new Error("An AL declaration has no body");
  let depth = 0;

  for (let index = open; index < outer.end; index++)
    if (outer.masked[index] === "{") depth++;
    else if (outer.masked[index] === "}" && --depth === 0)
      return { ...outer, start: open + 1, end: index };

  throw new Error("An AL declaration does not end");
};

// A property of a declaration's own body, outside the bodies nested in it.
const property = (body: Body, name: string) => {
  let depth = 0;
  let own = "";

  for (const character of body.masked.slice(body.start, body.end)) {
    if (character === "}") depth--;
    own += depth > 0 && character !== "\n" ? " " : character;

    if (character === "{") depth++;
  }

  const found = new RegExp(`^\\s*${name}\\s*=\\s*([^;]+);`, "md").exec(own)?.indices?.[1];

  return found && body.source.slice(body.start + found[0], body.start + found[1]).trim();
};

const allowed = (body: Body, name: string) =>
  property(body, name)?.toLowerCase() !== "false" &&
  property(body, "Editable")?.toLowerCase() !== "false";

const caption = (body: Body, name: string) => {
  const value = property(body, name);

  return value?.startsWith("'") ? alString(value) : "";
};

// The matches of a pattern in a body, outside comments and strings.
const matches = (body: Body, pattern: RegExp) =>
  [...body.masked.slice(body.start, body.end).matchAll(pattern)].map((match) => ({
    match,
    at: body.start + match.index,
  }));

/**
 * The standard API v2.0 page an AL file declares, or null for another object,
 * such as a query, or an API page of another group, such as automation.
 */
export const parsePage = (source: string): Page | null => {
  const file = { source, masked: structure(source), start: 0, end: source.length };
  const declaration = /^page\s+\d+\s+"([^"]+)"/m.exec(file.masked);

  if (!declaration) return null;
  const body = block(file, declaration.index);

  if (
    property(body, "PageType")?.toLowerCase() !== "api" ||
    property(body, "APIPublisher") !== undefined ||
    !property(body, "APIVersion")?.includes("'v2.0'")
  )
    return null;

  const layout = matches(body, /\blayout\b/g)[0];
  const content = layout ? block(body, layout.at) : { ...body, end: body.start };

  const fields = matches(content, /\bfield\(\s*("?)(\w+)\1\s*;/g).map(({ match, at }) => ({
    name: match[2] ?? "",
    editable: property(block(content, at), "Editable")?.toLowerCase() !== "false",
  }));

  const parts = matches(content, /\bpart\(\s*("?)(\w+)\1\s*;\s*"([^"]+)"\s*\)/g).map(
    ({ match, at }) => ({
      name: match[2] ?? "",
      page: match[3] ?? "",
      many: property(block(content, at), "Multiplicity")?.toLowerCase() !== "zeroorone",
    }),
  );

  const actions = matches(
    body,
    /\[ServiceEnabled\]((?:\s*\[[^\]]*\])*)\s*procedure\s+(\w+)\s*\(/dg,
  ).map(({ match, at }) => {
    const attributes = match.indices?.[1] ?? [0, 0];
    const offset = at - match.index;

    const text = source.slice(offset + attributes[0], offset + attributes[1]);
    const value = /\[Caption\(('(?:[^']|'')*')/.exec(text)?.[1];

    return { name: match[2] ?? "", caption: value ? alString(value) : "" };
  });

  return {
    page: declaration[1] ?? "",
    entityName: caption(body, "EntityName"),
    entitySetName: caption(body, "EntitySetName"),
    entityCaption: caption(body, "EntityCaption"),
    entitySetCaption: caption(body, "EntitySetCaption"),
    about: caption(body, "AboutText"),
    insert: allowed(body, "InsertAllowed"),
    modify: allowed(body, "ModifyAllowed"),
    delete: allowed(body, "DeleteAllowed"),
    fields,
    parts,
    actions,
  };
};

// Reference text: includes name the product or are notes, and links keep their text.
const plain = (text: string) =>
  text
    .replace(/\[!INCLUDE\[prod_(?:short|long)\]\([^)]*\)\]/g, "Business Central")
    .replace(/\[!INCLUDE\[[^\]]*\]\([^)]*\)\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

// The rows of the table in a section of a reference page, as cells.
const table = (markdown: string, heading: string) => {
  const start = markdown.search(new RegExp(`^## ${heading}\\s*$`, "m"));

  if (start < 0) return [];
  const rest = markdown.slice(start + 3);
  const end = rest.search(/^## /m);

  return (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*:?-/.test(line))
    .slice(1)
    .map((line) => line.replace(/^\||\|\s*$/g, "").split("|"));
};

/** An entity's page in the API reference: its summary, properties and navigation. */
export const parseReference = (markdown: string): Reference => ({
  summary: plain(/^Represents [^\n]+/m.exec(markdown)?.[0] ?? ""),
  properties: table(markdown, "Properties").map(([name = "", type = "", description = ""]) => ({
    name: name.trim(),
    type: type.trim(),
    description: plain(description),
  })),
  navigation: table(markdown, "Navigation").map(([link = ""]) => plain(link).replace(/\s/g, "")),
});

// The reference's types. Enumerations, such as `NAV.contactType`, are strings
// of the values their description lists.
const types = new Map<string, Schema>([
  ["guid", { type: "string", format: "uuid" }],
  ["string", { type: "string" }],
  ["date", { type: "string", format: "date" }],
  ["datetime", { type: "string", format: "date-time" }],
  ["decimal", { type: "number" }],
  ["number", { type: "number" }],
  ["integer", { type: "integer" }],
  ["int", { type: "integer" }],
  ["int32", { type: "integer" }],
  ["int64", { type: "integer", format: "int64" }],
  ["boolean", { type: "boolean" }],
]);

const typeOf = (entity: string, value: Property) => {
  if (value.type.startsWith("NAV.")) return { type: "string" };
  const known = types.get(value.type.toLowerCase());

  if (!known) throw new Error(`${entity}.${value.name} has the unknown type ${value.type}`);

  return known;
};

// Media fields, such as a PDF's content, are read at their own address.
const isMedia = (value: Property | undefined) => value?.type === "stream";

const upper = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

const lower = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

// A caption in a sentence: words such as `Sales` in lowercase, abbreviations
// such as `G/L` or `PDF` as they are.
const phrase = (caption: string) =>
  caption.replace(/\b[A-Z][a-z]+\b/g, (word) => word.toLowerCase());

const article = (text: string) => `${/^[aeiou]/i.test(text) ? "an" : "a"} ${text}`;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schema: Schema) => ({ "application/json": { schema } });

const odataQuery = {
  filter: {
    name: "$filter",
    in: "query",
    description:
      "An OData filter, such as `number eq '10000'` or `lastModifiedDateTime gt 2026-01-01T00:00:00Z`.",
    schema: { type: "string" },
  },
  select: {
    name: "$select",
    in: "query",
    description: "The properties to return.",
    explode: false,
    schema: { type: "array", items: { type: "string" } },
  },
  expand: {
    name: "$expand",
    in: "query",
    description:
      "Navigation properties to return with each entity, such as an invoice's `salesInvoiceLines`.",
    schema: { type: "string" },
  },
  orderby: {
    name: "$orderby",
    in: "query",
    description: "The order of the results, such as `number desc`.",
    schema: { type: "string" },
  },
  top: {
    name: "$top",
    in: "query",
    description: "The number of entities to return.",
    schema: { type: "integer" },
  },
  skip: {
    name: "$skip",
    in: "query",
    description: "The number of entities to skip.",
    schema: { type: "integer" },
  },
} satisfies Record<string, Parameter>;

const environment: Parameter = {
  name: "environment",
  in: "path",
  required: true,
  description:
    "The environment's name, such as `production` or `sandbox`, as `listEnvironments` returns it.",
  schema: { type: "string" },
};

const keyOf = (page: Pick<Page, "entityName" | "entityCaption">): Parameter => ({
  name: `${page.entityName}Id`,
  in: "path",
  required: true,
  description: `The \`id\` of the ${phrase(page.entityCaption)}.`,
  schema: { type: "string", format: "uuid" },
});

const company = keyOf({ entityName: "company", entityCaption: "Company" });

const companies = "/v2.0/{environment}/api/v2.0/companies";

/**
 * The OpenAPI description of the API pages and their reference: one schema per
 * entity with a reference page, and the operations of each entity set of a
 * company and of each subpage of those sets.
 */
export const openapiDescription = (
  sources: readonly string[],
  references: Readonly<Record<string, Reference>>,
  environments: string,
) => {
  const pages = sources.flatMap((source) => parsePage(source) ?? []);
  const byPage = new Map(pages.map((page) => [page.page, page]));
  const schemas: Record<string, Schema> = {};
  const paths: Record<string, Record<string, Operation>> = {};

  // Reference pages are named by their entity, in any case.
  const referenceOf = (entityName: string) =>
    Object.entries(references).find(
      ([name]) => name.toLowerCase() === `dynamics_${entityName.toLowerCase()}.md`,
    )?.[1];

  const described = (page: Page | undefined): page is Page =>
    page !== undefined && referenceOf(page.entityName) !== undefined;

  const propertiesOf = (name: string, found: Reference, page: Page | undefined) => {
    const writable = page ? page.insert || page.modify : false;

    const etag: Schema = {
      type: "string",
      description: writable
        ? "The entity's version. Pass it as `etag` to change or delete the entity."
        : "The entity's version.",
    };

    if (writable) etag.readOnly = true;
    const properties = new Map([["@odata.etag", etag]]);
    const fields = page?.fields ?? found.properties.map(({ name }) => ({ name, editable: false }));

    for (const field of fields) {
      const value = found.properties.find((candidate) => candidate.name === field.name);

      if (isMedia(value)) continue;
      // Entities that cannot be written are read whole; only writable ones mark
      // the fields Business Central fills itself.
      const readOnly = writable && !field.editable;

      // A field the reference does not list yet keeps any JSON value.
      const typed: Schema = value ? { ...typeOf(name, value) } : {};

      if (value?.description) typed.description = value.description;

      if (readOnly) typed.readOnly = true;
      properties.set(field.name, typed);
    }

    for (const part of page?.parts ?? []) {
      const child = byPage.get(part.page);

      if (!described(child)) continue;
      const target = ref(schema(child.entityName, child));

      properties.set(
        part.name,
        part.many
          ? { type: "array", items: target, "x-ms-navigationProperty": true }
          : { ...target, "x-ms-navigationProperty": true },
      );
    }

    return Object.fromEntries(properties);
  };

  const schema = (entityName: string, page: Page | undefined) => {
    const name = upper(entityName);
    const found = referenceOf(entityName);

    if (!found) throw new Error(`The API reference has no page for ${entityName}`);

    if (!schemas[name]) {
      // Set first, so the subpages a page names, which may name it again, end.
      schemas[name] = {};
      schemas[name] = {
        type: "object",
        description: page?.about || found.summary,
        properties: propertiesOf(name, found, page),
      };
      schemas[`${name}CollectionResponse`] = {
        type: "object",
        properties: {
          value: { type: "array", items: ref(name) },
          "@odata.nextLink": {
            type: "string",
            description:
              "The address of the next page, when there are more entities. Pass it as `nextLink` to the same method.",
          },
        },
      };
    }

    return name;
  };

  const add = (path: string, method: string, operation: Operation) => {
    const item = (paths[path] ??= {});

    if (item[method]) throw new Error(`${method.toUpperCase()} ${path} is described twice`);
    item[method] = operation;
  };

  const noContent = { "204": { description: "No content" } };

  // The content of an entity's media fields, such as a PDF document's.
  const media = (id: string, page: Page, path: string, parameters: Parameter[]) => {
    for (const field of referenceOf(page.entityName)?.properties.filter(isMedia) ?? [])
      add(`${path}/${field.name}`, "get", {
        operationId: `${id}.${field.name}`,
        summary: field.description || `Get the ${field.name} of the ${phrase(page.entityCaption)}.`,
        parameters,
        responses: {
          "200": {
            description: "The content",
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      });
  };

  // The operations of the entities of a page at a collection's address.
  const collection = (
    id: string,
    page: Page,
    path: string,
    parameters: Parameter[],
    items: boolean,
  ) => {
    const name = schema(page.entityName, page);
    const key = keyOf(page);
    const item = `${path}({${key.name}})`;
    const itemParameters = [...parameters, key];

    add(path, "get", {
      operationId: `${id}.list`,
      summary: `List ${phrase(page.entitySetCaption)}.`,
      description: page.about,
      parameters: [...parameters, ...Object.values(odataQuery)],
      responses: {
        "200": { description: "The entities", content: json(ref(`${name}CollectionResponse`)) },
      },
      "x-ms-pageable": { nextLinkName: "@odata.nextLink" },
    });

    if (page.insert)
      add(path, "post", {
        operationId: `${id}.create`,
        summary: `Create ${article(phrase(page.entityCaption))}.`,
        parameters,
        requestBody: {
          required: true,
          description: `The new ${phrase(page.entityCaption)}.`,
          content: json(ref(name)),
        },
        responses: { "201": { description: "The new entity", content: json(ref(name)) } },
      });

    if (!items) return;

    add(item, "get", {
      operationId: `${id}.get`,
      summary: `Get ${article(phrase(page.entityCaption))}.`,
      parameters: [...itemParameters, odataQuery.select, odataQuery.expand],
      responses: { "200": { description: "The entity", content: json(ref(name)) } },
    });

    if (page.modify)
      add(item, "patch", {
        operationId: `${id}.update`,
        summary: `Update ${article(phrase(page.entityCaption))}.`,
        parameters: itemParameters,
        requestBody: {
          required: true,
          description: "The properties to change. Properties left out keep their values.",
          content: json(ref(name)),
        },
        responses: { "200": { description: "The changed entity", content: json(ref(name)) } },
      });

    if (page.delete)
      add(item, "delete", {
        operationId: `${id}.delete`,
        summary: `Delete ${article(phrase(page.entityCaption))}.`,
        parameters: itemParameters,
        responses: noContent,
      });

    for (const action of page.actions)
      add(`${item}/Microsoft.NAV.${lower(action.name)}`, "post", {
        operationId: `${id}.${lower(action.name)}`,
        summary: action.caption ? `${action.caption}.` : upper(lower(action.name)),
        parameters: itemParameters,
        responses: noContent,
      });

    media(id, page, item, itemParameters);

    // Subpages are served below each entity. A subpage that is also a set of
    // the company, such as an invoice's lines, is read and changed there; its
    // entities are listed and created below their parent.
    for (const part of page.parts) {
      const child = byPage.get(part.page);

      if (!described(child)) continue;
      const nested = `${item}/${part.name}`;

      if (part.many)
        collection(
          `${id}.${part.name}`,
          child,
          nested,
          itemParameters,
          !companySets.has(part.name),
        );
      else single(`${id}.${part.name}`, child, nested, itemParameters);
    }
  };

  // A subpage with at most one entity, such as a document's PDF.
  const single = (id: string, page: Page, path: string, parameters: Parameter[]) => {
    const name = schema(page.entityName, page);

    add(path, "get", {
      operationId: `${id}.get`,
      summary: `Get the ${phrase(page.entityCaption)}.`,
      description: page.about,
      parameters: [...parameters, odataQuery.select],
      responses: { "200": { description: "The entity", content: json(ref(name)) } },
    });

    media(id, page, path, parameters);
  };

  // Companies are the platform's entity, described by the reference alone.
  const companyReference = referenceOf("company");

  if (!companyReference) throw new Error("The API reference has no page for company");
  const companySets = new Set(companyReference.navigation);
  const companyName = schema("company", undefined);

  add(companies, "get", {
    operationId: "companies.list",
    summary: "List the companies of an environment.",
    description: companyReference.summary,
    parameters: [environment, ...Object.values(odataQuery)],
    responses: {
      "200": {
        description: "The companies",
        content: json(ref(`${companyName}CollectionResponse`)),
      },
    },
    "x-ms-pageable": { nextLinkName: "@odata.nextLink" },
  });
  add(`${companies}({companyId})`, "get", {
    operationId: "companies.get",
    summary: "Get a company.",
    parameters: [environment, company, odataQuery.select],
    responses: { "200": { description: "The company", content: json(ref(companyName)) } },
  });

  for (const page of pages)
    if (companySets.has(page.entitySetName) && described(page))
      collection(
        page.entitySetName,
        page,
        `${companies}({companyId})/${page.entitySetName}`,
        [environment, company],
        true,
      );

  // The environments endpoint answers the reference's sample: one line per
  // property, with its type and a comment.
  const environmentProperties = Object.fromEntries(
    [...environments.matchAll(/^\s*"(\w+)":\s*(\w+),?\s*\/\/\s*(.+)$/gm)].map((match) => [
      match[1] ?? "",
      {
        ...typeOf("environment", { name: match[1] ?? "", type: match[2] ?? "", description: "" }),
        description: (match[3] ?? "").trim(),
      },
    ]),
  );

  if (!environmentProperties["name"]) throw new Error("The environments reference lists no name");
  schemas["Environment"] = {
    type: "object",
    description: "A Business Central environment of the user's tenant.",
    properties: environmentProperties,
  };
  add("/environments/v1.2", "get", {
    operationId: "environments.list",
    summary: "List the Business Central environments of the user's tenant.",
    description: "Pass an environment's `name` as `environment` to the other methods.",
    parameters: [],
    responses: {
      "200": {
        description: "The environments",
        content: json({
          type: "object",
          properties: { value: { type: "array", items: ref("Environment") } },
        }),
      },
    },
  });

  return {
    openapi: "3.0.4",
    info: { title: "Business Central API v2.0", version: "v2.0" },
    servers: [{ url: "https://api.businesscentral.dynamics.com/" }],
    paths,
    components: { schemas },
  };
};

const fetched = async (url: string) => {
  const response = await fetch(url, { headers: { accept: "application/vnd.github.raw" } });

  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);

  return response.text();
};

const listing = z.array(z.object({ name: z.string(), download_url: z.url().nullable() }));

// The AL and Markdown files of a GitHub directory, by name.
const directory = async (path: string) => {
  const files = listing
    .parse(JSON.parse(await fetched(`https://api.github.com/repos/${path}`)))
    .flatMap(({ name, download_url }) =>
      download_url && /\.(al|md)$/.test(name) ? [[name, download_url] as const] : [],
    );

  return Object.fromEntries(
    await Promise.all(files.map(async ([name, url]) => [name, await fetched(url)] as const)),
  );
};

/** The current OpenAPI description, as JSON text. */
export const download = async () => {
  const [pages, references, environments] = await Promise.all([
    directory(pagesDirectory),
    directory(referenceDirectory),
    fetched(environmentsPage),
  ]);

  return JSON.stringify(
    openapiDescription(
      Object.values(pages),
      Object.fromEntries(
        Object.entries(references).map(([name, text]) => [name, parseReference(text)]),
      ),
      environments,
    ),
  );
};
