// Reads an OData service's CSDL XML, its `$metadata`, as the OpenAPI 3 document
// the OpenAPI generator reads. Microsoft Dataverse describes its Web API only
// this way. CSDL names no paths; OData's conventions give them:
//
// - every entity set is read, created, changed and deleted at `/{entitySet}`
//   and `/{entitySet}({id})`, optionally cast to a derived type, one column
//   is read at `/{entitySet}({id})/{property}`, and its content below
//   `$value`,
// - related rows are read, created, replaced and deleted through a navigation
//   property, and rows are linked through `$ref`,
// - actions and functions the CSDL does not describe, such as those of a
//   solution installed later, are called by name at the service root, on a
//   collection or on a row,
// - an action imported into the service root is a POST to `/{name}` with its
//   parameters as the JSON body,
// - a function imported into the service root is a GET to `/{name}(...)`,
// - an action or function bound to an entity type is called on a row of that
//   type, or on its collection, under the type's qualified name.
//
// Function parameters that hold one value are written into the call, strings
// and enum members quoted as OData literals. Lists, objects and rows are
// passed as parameter aliases, query parameters named `@name` whose values
// the runtime sends as JSON. Unbound functions and actions that are not
// imported, such as the query functions of `$filter`, cannot be called and
// are left out.
import type { Json, JsonObject } from "./rules.ts";

/** One XML element: its name without prefix, attributes and child elements. */
interface Element {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
}

const entities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

const decode = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));

    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));

    return entities.get(entity) ?? whole;
  });

/**
 * The elements of an XML document. CSDL keeps everything in elements and
 * attributes, so text, comments and processing instructions are skipped.
 */
const parseXml = (text: string): Element => {
  const root: Element = { name: "", attributes: {}, children: [] };
  const open = [root];
  const tag = /<(\/?)([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<[?!][^>]*>/g;

  for (const match of text.matchAll(tag)) {
    const [, closing, qualified, attributeText, selfClosing] = match;

    if (qualified === undefined) continue;
    const name = qualified.replace(/^[\w.-]+:/, "");
    const parent = open.at(-1);

    if (!parent) throw new Error("The CSDL document has more closing than opening tags");

    if (closing) {
      if (parent.name !== name)
        throw new Error(`The CSDL document closes ${name} inside ${parent.name}`);
      open.pop();
      continue;
    }

    const attributes = Object.fromEntries(
      [...(attributeText ?? "").matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
        ([, key = "", double, single]) => [key, decode(double ?? single ?? "")],
      ),
    );

    const element: Element = { name, attributes, children: [] };

    parent.children.push(element);

    if (!selfClosing) open.push(element);
  }

  if (open.length !== 1) throw new Error("The CSDL document ends inside an element");

  return root;
};

const childrenNamed = (element: Element, name: string) =>
  element.children.filter((child) => child.name === name);

const required = (element: Element, attribute: string) => {
  const value = element.attributes[attribute];

  if (value === undefined) throw new Error(`A CSDL ${element.name} has no ${attribute}`);

  return value;
};

/** Whether a description's text is a CSDL document rather than JSON or YAML. */
export const isCsdl = (text: string) => text.trimStart().startsWith("<");

// OData's primitive types as JSON values. Dataverse writes 64-bit integers and
// decimals as JSON numbers.
const primitives = new Map<string, JsonObject>([
  ["Edm.String", { type: "string" }],
  ["Edm.Boolean", { type: "boolean" }],
  ["Edm.Guid", { type: "string", format: "uuid" }],
  ["Edm.Byte", { type: "integer", format: "uint8" }],
  ["Edm.SByte", { type: "integer", format: "int8" }],
  ["Edm.Int16", { type: "integer", format: "int16" }],
  ["Edm.Int32", { type: "integer", format: "int32" }],
  ["Edm.Int64", { type: "integer", format: "int64" }],
  ["Edm.Decimal", { type: "number", format: "decimal" }],
  ["Edm.Double", { type: "number", format: "double" }],
  ["Edm.Single", { type: "number", format: "float" }],
  ["Edm.DateTimeOffset", { type: "string", format: "date-time" }],
  ["Edm.Date", { type: "string", format: "date" }],
  ["Edm.TimeOfDay", { type: "string", format: "time" }],
  ["Edm.Duration", { type: "string", format: "duration" }],
  ["Edm.Binary", { type: "string", format: "base64url" }],
  ["Edm.Untyped", {}],
]);

// Function parameters written into the call as they are; others are quoted.
const unquoted = new Set([
  "Edm.Boolean",
  "Edm.Guid",
  "Edm.Byte",
  "Edm.SByte",
  "Edm.Int16",
  "Edm.Int32",
  "Edm.Int64",
  "Edm.Decimal",
  "Edm.Double",
  "Edm.Single",
  "Edm.DateTimeOffset",
  "Edm.Date",
  "Edm.TimeOfDay",
]);

const collection = (type: string) => /^Collection\((.+)\)$/.exec(type)?.[1];

const reference = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });

/**
 * A CSDL document as an OpenAPI 3 document, with the server at `server`. A
 * variable of the address, such as `{environment}`, is a server variable with
 * its description from `variables`.
 */
export const csdlDescription = (
  text: string,
  server: string,
  variables: Readonly<Record<string, string>> = {},
): Json => {
  const document = parseXml(text);

  const dataServices = document.children
    .flatMap((child) => childrenNamed(child, "DataServices"))
    .at(0);

  if (!dataServices) throw new Error("The CSDL document has no DataServices");
  const schemaElements = childrenNamed(dataServices, "Schema");

  // Schemas may call themselves by an alias, such as Dataverse's `mscrm`.
  const namespaces = new Map(
    schemaElements.flatMap((schema) => {
      const namespace = required(schema, "Namespace");
      const alias = schema.attributes["Alias"];

      return [[namespace, namespace], ...(alias ? [[alias, namespace] as const] : [])];
    }),
  );

  const qualified = (name: string) => {
    const dot = name.lastIndexOf(".");
    const namespace = namespaces.get(name.slice(0, dot));

    return namespace ? `${namespace}.${name.slice(dot + 1)}` : name;
  };

  const declared = (kind: string) =>
    new Map<string, Element>(
      schemaElements.flatMap((schema) =>
        childrenNamed(schema, kind).map(
          (element) =>
            [`${required(schema, "Namespace")}.${required(element, "Name")}`, element] as const,
        ),
      ),
    );

  const entityTypes = declared("EntityType");
  const complexTypes = declared("ComplexType");
  const enumTypes = declared("EnumType");

  const isEntity = (type: string) => entityTypes.has(qualified(type));

  // An entity type without properties of its own, such as Dataverse's
  // `crmbaseentity`, stands for a row of any table.
  const anyRow = (name: string) => {
    const element = entityTypes.get(name);

    return (
      element !== undefined &&
      element.attributes["BaseType"] === undefined &&
      childrenNamed(element, "Property").length === 0
    );
  };

  /** The schema of a value of a CSDL type. */
  const valueSchema = (type: string, nullable: boolean): JsonObject => {
    const item = collection(type);

    if (item !== undefined) return { type: "array", items: valueSchema(item, false) };
    const name = qualified(type);
    const primitive = primitives.get(name);

    if (primitive) return nullable ? { ...primitive, nullable: true } : { ...primitive };

    if (!entityTypes.has(name) && !complexTypes.has(name) && !enumTypes.has(name))
      throw new Error(`The CSDL type ${type} is not described`);

    // Graph's descriptions write a nullable reference the same way.
    return nullable ? { anyOf: [reference(name)], nullable: true } : reference(name);
  };

  // A complex type's navigation properties are values it carries, such as the
  // principal a sharing action's `PrincipalAccess` names. An entity type's are
  // relationships, which are read with `$expand` and set with `@odata.bind`.
  const propertiesOf = (element: Element, navigation: boolean) =>
    Object.fromEntries(
      [
        ...childrenNamed(element, "Property"),
        ...(navigation ? childrenNamed(element, "NavigationProperty") : []),
      ].map((property) => [
        required(property, "Name"),
        valueSchema(required(property, "Type"), property.attributes["Nullable"] !== "false"),
      ]),
    );

  /** A structured type's schema, with its base type's properties through `allOf`. */
  const structuredSchema = (name: string, element: Element): JsonObject => {
    if (anyRow(name))
      return {
        type: "object",
        description:
          "A row of any table, with `@odata.type` naming its type, such as `Microsoft.Dynamics.CRM.account`.",
        additionalProperties: true,
      };

    const own: JsonObject = {
      type: "object",
      properties: propertiesOf(element, complexTypes.has(name)),
    };

    if (element.attributes["OpenType"] === "true") own["additionalProperties"] = true;
    const base = element.attributes["BaseType"];

    return base && !anyRow(qualified(base)) ? { allOf: [reference(qualified(base)), own] } : own;
  };

  const schemas: JsonObject = {};

  for (const [name, element] of [...entityTypes, ...complexTypes])
    schemas[name] = structuredSchema(name, element);

  for (const [name, element] of enumTypes) {
    const members = childrenNamed(element, "Member").map((member) => required(member, "Name"));

    // Flags combine their members, written comma-separated.
    schemas[name] =
      element.attributes["IsFlags"] === "true"
        ? {
            type: "string",
            description: `Any of ${members.map((member) => `\`${member}\``).join(", ")}, separated by commas.`,
          }
        : { type: "string", enum: members };
  }

  const container = schemaElements
    .flatMap((schema) => childrenNamed(schema, "EntityContainer"))
    .at(0);

  if (!container) throw new Error("The CSDL document has no EntityContainer");

  // Entity sets by their entity type; a type with one set is addressed through it.
  const sets = new Map<string, string[]>();

  for (const set of childrenNamed(container, "EntitySet")) {
    const type = qualified(required(set, "EntityType"));

    sets.set(type, [...(sets.get(type) ?? []), required(set, "Name")]);
  }

  const imported = (kind: string, attribute: string) =>
    new Set(
      childrenNamed(container, kind).map((element) => qualified(required(element, attribute))),
    );

  const importedActions = imported("ActionImport", "Action");
  const importedFunctions = imported("FunctionImport", "Function");
  const paths: Record<string, JsonObject> = {};

  const entitySet = {
    name: "entitySet",
    in: "path",
    required: true,
    description: "The entity set of the table, its plural name, such as `accounts`.",
    schema: { type: "string" },
  };

  const id = {
    name: "id",
    in: "path",
    required: true,
    description: "The row's ID, or an alternate key, such as `LogicalName='account'`.",
    schema: { type: "string" },
  };

  // A cast reads rows as a derived type, with the properties only it has, such
  // as the options of a choice column's `PicklistAttributeMetadata`.
  const cast = {
    name: "type",
    in: "path",
    required: false,
    description:
      "A derived type to read as, by its qualified name, such as `Microsoft.Dynamics.CRM.PicklistAttributeMetadata`.",
    schema: { type: "string" },
  };

  // OData joins a list of a query option with commas.
  const queryOption = (
    name: string,
    description: string,
    schema: JsonObject = { type: "string" },
  ) => {
    const option: JsonObject = { name, in: "query", description, schema };

    if (schema["type"] === "array") {
      option["style"] = "form";
      option["explode"] = false;
    }

    return option;
  };

  const select = queryOption(
    "$select",
    "The columns to return, by logical name. Lookup columns are named `_<name>_value`.",
    { type: "array", items: { type: "string" } },
  );

  const expand = queryOption(
    "$expand",
    "Related rows to include, by navigation property, such as `primarycontactid($select=fullname)`.",
  );

  const row = { type: "object", additionalProperties: true };
  const rowContent = { content: { "application/json": { schema: row } } };
  const noContent = { "204": { description: "Done." } };
  const answer = { "200": { description: "The result.", ...rowContent }, ...noContent };

  // OData's query options for a collection of rows.
  const listOptions = [
    select,
    queryOption("$filter", "A filter expression, such as `statecode eq 0`."),
    queryOption("$orderby", "The columns to sort by, each followed by `asc` or `desc`.", {
      type: "array",
      items: { type: "string" },
    }),
    queryOption("$top", "The most rows to return.", { type: "integer" }),
    expand,
    queryOption(
      "$apply",
      "Aggregation and grouping, such as `groupby((statecode),aggregate($count as count))`.",
    ),
    queryOption("$count", "Whether the answer includes the number of matching rows.", {
      type: "boolean",
    }),
    {
      name: "parameterAliases",
      in: "query",
      style: "form",
      explode: true,
      description:
        'The values of parameter aliases the query options use, such as `@p1` in `$filter`, as OData literals, such as `{ "@p1": "\'Contoso\'" }`.',
      schema: { type: "object", additionalProperties: { type: "string" } },
    },
  ];

  const rows = {
    "200": {
      description: "The matching rows.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              value: { type: "array", items: row },
              "@odata.count": { type: "integer" },
              "@odata.nextLink": { type: "string" },
              "@odata.deltaLink": { type: "string" },
            },
          },
        },
      },
    },
  };

  // The service document names the entity sets.
  paths["/"] = {
    get: {
      operationId: "service.get",
      summary: "List the service's entity sets, singletons and function imports.",
      responses: {
        "200": {
          description: "The service document.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  value: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        kind: { type: "string" },
                        url: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  // `$count` answers a number as text.
  const count = {
    "200": {
      description: "The number of rows.",
      content: { "text/plain": { schema: { type: "integer" } } },
    },
  };

  paths["/{entitySet}/$count"] = {
    get: {
      operationId: "entitySet.count",
      summary: "Count the rows of a table.",
      parameters: [entitySet],
      responses: count,
    },
  };

  paths["/{entitySet}/{type}"] = {
    get: {
      operationId: "entitySet.list",
      summary: "List the rows of a table that match a query.",
      parameters: [
        entitySet,
        cast,
        ...listOptions,
        queryOption("fetchXml", "A FetchXML query instead of the OData query options."),
      ],
      "x-ms-pageable": { nextLinkName: "@odata.nextLink" },
      responses: rows,
    },
  };

  paths["/{entitySet}"] = {
    post: {
      operationId: "entitySet.create",
      summary: "Create a row. Lookups are set with `<navigation property>@odata.bind`.",
      parameters: [entitySet, select, expand],
      requestBody: { required: true, ...rowContent },
      responses: { "201": { description: "The created row.", ...rowContent }, ...noContent },
    },
  };

  paths["/{entitySet}({id})/{type}"] = {
    get: {
      operationId: "entitySet.get",
      summary: "Get a row.",
      parameters: [entitySet, id, cast, select, expand],
      responses: { "200": { description: "The row.", ...rowContent } },
    },
  };

  paths["/{entitySet}({id})"] = {
    patch: {
      operationId: "entitySet.update",
      summary: "Change a row's columns, or create the row with this ID when it does not exist.",
      parameters: [entitySet, id, select],
      requestBody: { required: true, ...rowContent },
      responses: { "200": { description: "The changed row.", ...rowContent }, ...noContent },
    },
    put: {
      operationId: "entitySet.replace",
      summary:
        "Replace a row with the body, such as a table's definition, which cannot be changed in part.",
      parameters: [entitySet, id],
      requestBody: { required: true, ...rowContent },
      responses: noContent,
    },
    delete: {
      operationId: "entitySet.delete",
      summary: "Delete a row.",
      parameters: [entitySet, id],
      responses: noContent,
    },
  };

  const property = {
    name: "property",
    in: "path",
    required: true,
    description: "The column, by logical name, such as `name` or a file column.",
    schema: { type: "string" },
  };

  paths["/{entitySet}({id})/{property}"] = {
    get: {
      operationId: "entitySet.getProperty",
      summary: "Get one column of a row, as `value`.",
      parameters: [entitySet, id, property],
      responses: {
        "200": {
          description: "The column's value.",
          content: {
            "application/json": { schema: { type: "object", properties: { value: {} } } },
          },
        },
        ...noContent,
      },
    },
    put: {
      operationId: "entitySet.setProperty",
      summary: "Set one column of a row.",
      parameters: [entitySet, id, property],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: ["value"], properties: { value: {} } },
          },
        },
      },
      responses: noContent,
    },
    patch: {
      operationId: "entitySet.uploadProperty",
      summary: "Upload the content of a file or image column, at once or in chunks.",
      parameters: [entitySet, id, property],
      requestBody: {
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      responses: { "200": { description: "Accepted." }, ...noContent },
    },
    delete: {
      operationId: "entitySet.deleteProperty",
      summary: "Clear one column of a row, or delete the file of a file or image column.",
      parameters: [entitySet, id, property],
      responses: noContent,
    },
  };

  paths["/{entitySet}({id})/{property}/$value"] = {
    get: {
      operationId: "entitySet.getPropertyValue",
      summary: "Get the content of a file or image column, or a column's raw value.",
      parameters: [entitySet, id, property],
      responses: {
        "200": {
          description: "The content.",
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
  };

  const navigationProperty = {
    name: "navigationProperty",
    in: "path",
    required: true,
    description:
      "The navigation property that relates the rows, such as `contact_customer_accounts`.",
    schema: { type: "string" },
  };

  // The rows a row relates to, such as an account's contacts, or a table's
  // columns as `EntityDefinitions(LogicalName='account')/Attributes`.
  paths["/{entitySet}({id})/{navigationProperty}/{type}"] = {
    get: {
      operationId: "entitySet.listRelated",
      summary: "List the rows a row relates to through a navigation property.",
      parameters: [entitySet, id, navigationProperty, cast, ...listOptions],
      "x-ms-pageable": { nextLinkName: "@odata.nextLink" },
      responses: rows,
    },
  };

  paths["/{entitySet}({id})/{navigationProperty}/$count"] = {
    get: {
      operationId: "entitySet.countRelated",
      summary: "Count the rows a row relates to through a navigation property.",
      parameters: [entitySet, id, navigationProperty],
      responses: count,
    },
  };

  paths["/{entitySet}({id})/{navigationProperty}"] = {
    post: {
      operationId: "entitySet.createRelated",
      summary:
        "Create a row related to a row through a collection-valued navigation property, such as a column of a table.",
      parameters: [entitySet, id, navigationProperty],
      requestBody: { required: true, ...rowContent },
      responses: { "201": { description: "The created row.", ...rowContent }, ...noContent },
    },
  };

  const relatedId = {
    name: "relatedId",
    in: "path",
    required: true,
    description: "The related row's ID, or an alternate key, such as `LogicalName='name'`.",
    schema: { type: "string" },
  };

  // One of them, such as a column of a table as
  // `EntityDefinitions(LogicalName='account')/Attributes(LogicalName='name')`.
  paths["/{entitySet}({id})/{navigationProperty}({relatedId})/{type}"] = {
    get: {
      operationId: "entitySet.getRelated",
      summary: "Get a row a row relates to through a navigation property.",
      parameters: [entitySet, id, navigationProperty, relatedId, cast, select, expand],
      responses: { "200": { description: "The row.", ...rowContent } },
    },
  };

  paths["/{entitySet}({id})/{navigationProperty}({relatedId})"] = {
    patch: {
      operationId: "entitySet.updateRelated",
      summary: "Change the columns of a row a row relates to through a navigation property.",
      parameters: [entitySet, id, navigationProperty, relatedId],
      requestBody: { required: true, ...rowContent },
      responses: { "200": { description: "The changed row.", ...rowContent }, ...noContent },
    },
    put: {
      operationId: "entitySet.replaceRelated",
      summary:
        "Replace a row a row relates to with the body, such as a column's definition, which cannot be changed in part.",
      parameters: [entitySet, id, navigationProperty, relatedId],
      requestBody: { required: true, ...rowContent },
      responses: noContent,
    },
    delete: {
      operationId: "entitySet.deleteRelated",
      summary: "Delete a row a row relates to, such as a column of a table.",
      parameters: [entitySet, id, navigationProperty, relatedId],
      responses: noContent,
    },
  };

  // Addresses of other rows, relative to the service or absolute.
  const address = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["@odata.id"],
          properties: {
            "@odata.id": {
              type: "string",
              description:
                "The other row's address, such as `contacts(<id>)`, relative to the service or absolute.",
            },
          },
        },
      },
    },
  };

  paths["/{entitySet}({id})/{navigationProperty}/$ref"] = {
    get: {
      operationId: "entitySet.listReferences",
      summary: "List the addresses of the rows a row relates to through a navigation property.",
      parameters: [entitySet, id, navigationProperty],
      "x-ms-pageable": { nextLinkName: "@odata.nextLink" },
      responses: {
        "200": {
          description: "The addresses, as `@odata.id`.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  value: {
                    type: "array",
                    items: { type: "object", properties: { "@odata.id": { type: "string" } } },
                  },
                  "@odata.id": { type: "string" },
                  "@odata.nextLink": { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "entitySet.associate",
      summary: "Relate a row to another row through a navigation property.",
      parameters: [entitySet, id, navigationProperty],
      requestBody: address,
      responses: noContent,
    },
    put: {
      operationId: "entitySet.setReference",
      summary: "Set the row a single-valued navigation property, such as a lookup, refers to.",
      parameters: [entitySet, id, navigationProperty],
      requestBody: address,
      responses: noContent,
    },
    delete: {
      operationId: "entitySet.disassociate",
      summary: "Remove the relationship between a row and another row.",
      parameters: [
        entitySet,
        id,
        navigationProperty,
        queryOption(
          "$id",
          "For a collection-valued navigation property, the other row's address, such as `contacts(<id>)`.",
        ),
      ],
      responses: noContent,
    },
  };

  paths["/{entitySet}({id})/{navigationProperty}({relatedId})/$ref"] = {
    delete: {
      operationId: "entitySet.disassociateRelated",
      summary: "Remove the relationship between a row and one row of a collection it relates to.",
      parameters: [entitySet, id, navigationProperty, relatedId],
      responses: noContent,
    },
  };

  // Actions and functions the CSDL does not describe, such as those a solution
  // installed later adds. A bound one is named with its namespace.
  const action = (where: string) => ({
    name: "action",
    in: "path",
    required: true,
    description: `The action's name${where}.`,
    schema: { type: "string" },
  });

  const called = (where: string) => ({
    name: "function",
    in: "path",
    required: true,
    description: `The function's call${where}, with its parameters as aliases, such as \`msdyn_GetSummary(RecordId=@id)\`, or \`()\` after the name without parameters.`,
    schema: { type: "string" },
  });

  const aliases = {
    name: "parameterAliases",
    in: "query",
    style: "form",
    explode: true,
    description:
      'The values of the call\'s parameter aliases as OData literals, such as `{ "@id": "\'<id>\'" }`, or JSON for lists and objects.',
    schema: { type: "object", additionalProperties: { type: "string" } },
  };

  const actionCall = (operationId: string, summary: string, parameters: JsonObject[]) => ({
    post: {
      operationId,
      summary,
      parameters,
      requestBody: { content: { "application/json": { schema: row } } },
      responses: answer,
    },
  });

  const functionCall = (operationId: string, summary: string, parameters: JsonObject[]) => ({
    get: { operationId, summary, parameters: [...parameters, aliases], responses: answer },
  });

  paths["/{action}"] = actionCall(
    "action.call",
    "Call an action at the service root by its name, with its parameters as the body.",
    [action(", such as `msdyn_GetKAObjectFromTemplate`")],
  );

  paths["/{function}"] = functionCall("function.call", "Call a function at the service root.", [
    called(""),
  ]);

  const boundName = ", with its namespace, such as `Microsoft.Dynamics.CRM.new_Approve`";

  paths["/{entitySet}/{action}"] = actionCall(
    "entitySet.callAction",
    "Call an action bound to a table, with its parameters as the body.",
    [entitySet, action(boundName)],
  );

  paths["/{entitySet}/{function}"] = functionCall(
    "entitySet.callFunction",
    "Call a function bound to a table.",
    [entitySet, called(boundName)],
  );

  paths["/{entitySet}({id})/{action}"] = actionCall(
    "entitySet.callRowAction",
    "Call an action bound to a row, with its parameters as the body.",
    [entitySet, id, action(boundName)],
  );

  paths["/{entitySet}({id})/{function}"] = functionCall(
    "entitySet.callRowFunction",
    "Call a function bound to a row.",
    [entitySet, id, called(boundName)],
  );

  paths["/$metadata"] = {
    get: {
      operationId: "metadata.get",
      summary:
        "Get the service's CSDL: every table, column, relationship, action and function of this environment.",
      responses: {
        "200": {
          description: "The CSDL document.",
          content: { "application/xml": { schema: { type: "string" } } },
        },
      },
    },
  };

  /** The answer of an action or function. */
  const answers = (element: Element) => {
    const returned = childrenNamed(element, "ReturnType").at(0);

    if (!returned) return noContent;
    const type = required(returned, "Type");
    const value = valueSchema(type, returned.attributes["Nullable"] !== "false");

    // OData answers a structured value as itself, and a collection, a primitive
    // or an enum member inside an object's `value`.
    const structured =
      collection(type) === undefined &&
      (entityTypes.has(qualified(type)) || complexTypes.has(qualified(type)));

    return {
      "200": {
        description: "The result.",
        content: {
          "application/json": {
            schema: structured
              ? value
              : { type: "object", properties: { value }, required: ["value"] },
          },
        },
      },
    };
  };

  const optional = (parameter: Element) =>
    parameter.attributes["Nullable"] !== "false" ||
    childrenNamed(parameter, "Annotation").some(
      (annotation) => annotation.attributes["Term"] === "Org.OData.Core.V1.OptionalParameter",
    );

  /** The path where an operation bound to `type` runs, with its path parameters. */
  const boundPath = (type: string) => {
    const item = collection(type);
    const name = qualified(item ?? type);
    const named = sets.get(name);
    const one = named?.length === 1 ? named[0] : undefined;
    const set = one ?? "{entitySet}";
    const parameters = one ? [] : [entitySet];

    return item === undefined
      ? { path: `/${set}({id})`, parameters: [...parameters, id] }
      : { path: `/${set}`, parameters };
  };

  const operations = schemaElements.flatMap((schema) =>
    ["Action", "Function"].flatMap((kind) =>
      childrenNamed(schema, kind).map((element) => ({
        kind,
        element,
        name: `${required(schema, "Namespace")}.${required(element, "Name")}`,
      })),
    ),
  );

  for (const { kind, element, name } of operations) {
    const bound = element.attributes["IsBound"] === "true";
    const shortName = required(element, "Name");
    const [binding, ...parameters] = childrenNamed(element, "Parameter");

    if (!bound && !(kind === "Action" ? importedActions : importedFunctions).has(name)) continue;

    const inputs = bound ? parameters : childrenNamed(element, "Parameter");

    const at =
      bound && binding ? boundPath(required(binding, "Type")) : { path: "", parameters: [] };

    const bindingType =
      bound && binding
        ? qualified(collection(required(binding, "Type")) ?? required(binding, "Type"))
        : null;

    // A bound operation's segment is its qualified name; a root operation's, its name.
    const segment = bound ? name : shortName;

    const operationId = bindingType
      ? `${bindingType.slice(bindingType.lastIndexOf(".") + 1)}.${shortName}`
      : shortName;

    if (kind === "Action") {
      const properties = Object.fromEntries(
        inputs.map((parameter) => [
          required(parameter, "Name"),
          valueSchema(required(parameter, "Type"), parameter.attributes["Nullable"] !== "false"),
        ]),
      );

      const requiredNames = inputs
        .filter((parameter) => !optional(parameter))
        .map((parameter) => required(parameter, "Name"));

      const body: JsonObject = { type: "object", properties };

      if (requiredNames.length) body["required"] = requiredNames;
      const post: JsonObject = { operationId, parameters: at.parameters };

      // An action without parameters takes no body.
      if (inputs.length)
        post["requestBody"] = {
          required: requiredNames.length > 0,
          content: { "application/json": { schema: body } },
        };
      post["responses"] = answers(element);
      paths[`${at.path}/${segment}`] = { post };

      continue;
    }

    // Values written into the call, and aliases for lists, objects and rows.
    const written = inputs.map((parameter) => {
      const parameterName = required(parameter, "Name");
      const type = required(parameter, "Type");
      const typeName = qualified(type);
      const schema = valueSchema(type, false);
      const isOptional = optional(parameter);

      if (collection(type) !== undefined || complexTypes.has(typeName) || isEntity(type))
        return {
          argument: `${parameterName}=@${parameterName}`,
          parameter: { name: `@${parameterName}`, in: "query", required: !isOptional, schema },
        };

      const value = enumTypes.has(typeName)
        ? `${typeName}'{${parameterName}}'`
        : unquoted.has(typeName)
          ? `{${parameterName}}`
          : `'{${parameterName}}'`;

      return {
        argument: `${parameterName}=${value}`,
        parameter: { name: parameterName, in: "path", required: !isOptional, schema },
      };
    });

    paths[`${at.path}/${segment}(${written.map((value) => value.argument).join(",")})`] = {
      get: {
        operationId,
        parameters: [...at.parameters, ...written.map((value) => value.parameter)],
        responses: answers(element),
      },
    };
  }

  return {
    openapi: "3.0.4",
    info: { title: "OData service", version: "1" },
    servers: [
      {
        url: server,
        variables: Object.fromEntries(
          [...server.matchAll(/\{([^}]+)\}/g)].map(([, name = ""]) => [
            name,
            { default: name, description: variables[name] ?? `The \`${name}\` of the address.` },
          ]),
        ),
      },
    ],
    paths,
    components: { schemas },
  };
};
