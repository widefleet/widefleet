import { describe, expect, it } from "vitest";
import { z } from "zod";
import { csdlDescription, isCsdl } from "./csdl.ts";
import { generateOpenapi, parseDescription } from "./openapi.ts";
import { type RestOperation, restRequest } from "./runtime/rest.ts";

// A CSDL document in the shape Dataverse serves: an alias for its namespace,
// rows of any table, bound and imported operations, and a query function
// that only `$filter` calls.
const csdl = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Example.Service" Alias="svc" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="baseentity" Abstract="true" />
      <EntityType Name="role" BaseType="svc.baseentity">
        <Key><PropertyRef Name="roleid" /></Key>
        <Property Name="roleid" Type="Edm.Guid" Nullable="false" />
        <Property Name="name" Type="Edm.String" />
        <NavigationProperty Name="users" Type="Collection(svc.user)" />
      </EntityType>
      <EntityType Name="user" BaseType="svc.baseentity">
        <Key><PropertyRef Name="userid" /></Key>
        <Property Name="userid" Type="Edm.Guid" Nullable="false" />
      </EntityType>
      <ComplexType Name="Privilege">
        <Property Name="Depth" Type="svc.Depth" />
        <Property Name="PrivilegeId" Type="Edm.Guid" />
      </ComplexType>
      <ComplexType Name="PrincipalAccess">
        <Property Name="AccessMask" Type="Edm.String" />
        <NavigationProperty Name="Principal" Type="svc.baseentity" />
      </ComplexType>
      <ComplexType Name="WhoAmIResponse">
        <Property Name="UserId" Type="Edm.Guid" Nullable="false" />
      </ComplexType>
      <EnumType Name="Depth"><Member Name="Basic" Value="0" /><Member Name="Global" Value="3" /></EnumType>
      <EnumType Name="Filters" IsFlags="true"><Member Name="Entity" Value="1" /><Member Name="Attributes" Value="2" /></EnumType>
      <Action Name="AddPrivilegesRole" IsBound="true">
        <Parameter Name="entity" Type="svc.role" Nullable="false" />
        <Parameter Name="Privileges" Type="Collection(svc.Privilege)" Nullable="false" />
      </Action>
      <Action Name="PublishXml">
        <Parameter Name="ParameterXml" Type="Edm.String" Nullable="false" />
      </Action>
      <Function Name="WhoAmI"><ReturnType Type="svc.WhoAmIResponse" Nullable="false" /></Function>
      <Function Name="RetrieveCount">
        <Parameter Name="EntityName" Type="Edm.String" Nullable="false" />
        <Parameter Name="Since" Type="Edm.DateTimeOffset" Nullable="true">
          <Annotation Term="Org.OData.Core.V1.OptionalParameter" />
        </Parameter>
        <Parameter Name="Depth" Type="svc.Depth" Nullable="false" />
        <Parameter Name="Target" Type="svc.baseentity" Nullable="false" />
        <ReturnType Type="Edm.Int32" Nullable="false" />
      </Function>
      <Function Name="LastXDays">
        <Parameter Name="PropertyName" Type="Edm.String" Nullable="false" />
        <ReturnType Type="Edm.Boolean" Nullable="false" />
      </Function>
      <EntityContainer Name="System">
        <EntitySet Name="roles" EntityType="Example.Service.role" />
        <EntitySet Name="users" EntityType="Example.Service.user" />
        <ActionImport Name="PublishXml" Action="Example.Service.PublishXml" />
        <FunctionImport Name="WhoAmI" Function="Example.Service.WhoAmI" />
        <FunctionImport Name="RetrieveCount" Function="Example.Service.RetrieveCount" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const server = "https://environment.example.test/api/data/v9.2";

const document = z
  .object({
    servers: z.array(z.object({ url: z.string() })),
    paths: z.record(z.string(), z.record(z.string(), z.looseObject({ operationId: z.string() }))),
    components: z.object({ schemas: z.record(z.string(), z.json()) }),
  })
  .parse(csdlDescription(csdl, server));

const operationIds = Object.values(document.paths).flatMap((item) =>
  Object.values(item).map((operation) => operation.operationId),
);

describe("CSDL descriptions", () => {
  it("are recognized and served at the address of their $metadata", () => {
    expect(isCsdl(`\n${csdl}`)).toBe(true);
    expect(isCsdl('{"openapi":"3.0.0"}')).toBe(false);
    expect(parseDescription(csdl, `${server}/$metadata`)).toEqual(csdlDescription(csdl, server));
    expect(() => parseDescription(csdl)).toThrow("needs the address of its $metadata");
  });

  it("offer the rows of every table and the operations the service can call", () => {
    expect(document.servers).toEqual([{ url: server }]);
    expect(operationIds.toSorted()).toEqual(
      [
        "RetrieveCount",
        "PublishXml",
        "WhoAmI",
        "action.call",
        "entitySet.associate",
        "entitySet.callAction",
        "entitySet.callFunction",
        "entitySet.callRowAction",
        "entitySet.callRowFunction",
        "entitySet.count",
        "entitySet.countRelated",
        "entitySet.create",
        "entitySet.createRelated",
        "entitySet.delete",
        "entitySet.deleteProperty",
        "entitySet.deleteRelated",
        "entitySet.disassociate",
        "entitySet.disassociateRelated",
        "entitySet.get",
        "entitySet.getProperty",
        "entitySet.getPropertyValue",
        "entitySet.getRelated",
        "entitySet.list",
        "entitySet.listReferences",
        "entitySet.listRelated",
        "entitySet.replace",
        "entitySet.replaceRelated",
        "entitySet.setProperty",
        "entitySet.setReference",
        "entitySet.update",
        "entitySet.uploadProperty",
        "function.call",
        "metadata.get",
        "service.get",
        "role.AddPrivilegesRole",
      ].toSorted(),
    );
    // A query function that only `$filter` calls is not imported, so not offered.
    expect(operationIds).not.toContain("LastXDays");
  });

  it("address bound operations through their type's entity set", () => {
    expect(
      document.paths["/roles({id})/Example.Service.AddPrivilegesRole"]?.["post"],
    ).toMatchObject({
      operationId: "role.AddPrivilegesRole",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              required: ["Privileges"],
              properties: {
                Privileges: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Example.Service.Privilege" },
                },
              },
            },
          },
        },
      },
      responses: { "204": { description: "Done." } },
    });
    expect(document.paths["/PublishXml"]?.["post"]).toMatchObject({ operationId: "PublishXml" });
  });

  it("write function parameters into the call and pass lists, objects and rows as aliases", () => {
    expect(Object.keys(document.paths)).toContain(
      "/RetrieveCount(EntityName='{EntityName}',Since={Since},Depth=Example.Service.Depth'{Depth}',Target=@Target)",
    );
    expect(Object.keys(document.paths)).toContain("/WhoAmI()");
  });

  it("type structures, enums and rows of any table", () => {
    const { schemas } = document.components;
    expect(schemas["Example.Service.role"]).toEqual({
      type: "object",
      properties: {
        roleid: { type: "string", format: "uuid" },
        name: { type: "string", nullable: true },
      },
    });
    // A complex type carries its navigation properties, an entity type does not.
    expect(schemas["Example.Service.PrincipalAccess"]).toMatchObject({
      properties: {
        AccessMask: { type: "string", nullable: true },
        Principal: { anyOf: [{ $ref: "#/components/schemas/Example.Service.baseentity" }] },
      },
    });
    expect(schemas["Example.Service.Depth"]).toEqual({ type: "string", enum: ["Basic", "Global"] });
    expect(schemas["Example.Service.Filters"]).toMatchObject({ type: "string" });
    expect(schemas["Example.Service.baseentity"]).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
  });

  it("generate typed methods and the requests OData expects", () => {
    const generated = generateOpenapi(
      parseDescription(csdl, `${server}/$metadata`),
      {
        operations: {
          "entitySet.list": { name: "listRows" },
          "role.AddPrivilegesRole": { name: "addPrivilegesRole", change: "update" },
          WhoAmI: { name: "whoAmI" },
          RetrieveCount: { name: "retrieveCount" },
        },
      },
      {
        name: "Example",
        className: "ExampleApi",
        result: "ExampleResult",
        properties: "ExampleProperties",
        typePrefix: "Example.Service.",
      },
      "",
    );

    const api = generated.files["src/api.ts"] ?? "";
    expect(api).toContain("async retrieveCount(input: {");
    // An optional parameter of a function may be left out.
    expect(api).toMatch(/Since\?: string/);
    expect(api).toMatch(/Target: Baseentity;/);

    // The alias's input drops its `@`; the function's values fill its call.
    const schema = generated.files["src/schema.ts"] ?? "";
    expect(schema).toMatch(/Target"?:\s*\[\s*"@Target",\s*null,\s*true\s*\]/);
    expect(schema).toMatch(/Since"?:\s*"Since"/);
    expect(schema).toMatch(/optionalPathParameters"?:\s*\[\s*"Since"\s*\]/);
    // OData answers a primitive inside `value`.
    expect(api).toMatch(/retrieveCount[\s\S]*?Promise<ExampleResult<\{\s*value: number;?\s*\}>>/);

    const call = {
      httpMethod: "GET",
      headerParameters: {},
      body: null,
      bodyRequired: false,
      response: "json",
      pageable: false,
    } as const;

    const count: RestOperation = {
      ...call,
      path: "/RetrieveCount(EntityName='{EntityName}',Since={Since},Depth=Example.Service.Depth'{Depth}',Target=@Target)",
      pathParameters: { EntityName: "EntityName", Since: "Since", Depth: "Depth" },
      optionalPathParameters: ["Since"],
      queryParameters: { Target: ["@Target", null, true] },
    };

    const whoAmI: RestOperation = {
      ...call,
      path: "/WhoAmI()",
      pathParameters: {},
      queryParameters: {},
    };

    expect(
      decodeURIComponent(
        restRequest(`${server}/`, "retrieveCount", count, {
          EntityName: "o'clock",
          Depth: "Global",
          Target: { "@odata.id": "roles(1)" },
        }).url,
      ),
    ).toBe(
      `${server}/RetrieveCount(EntityName='o''clock',Depth=Example.Service.Depth'Global',Target=@Target)?@Target={"@odata.id":"roles(1)"}`,
    );
    expect(
      decodeURIComponent(
        restRequest(`${server}/`, "retrieveCount", count, {
          EntityName: "account",
          Since: "2026-01-01T00:00:00Z",
          Depth: "Basic",
          Target: {},
        }).url,
      ),
    ).toContain("RetrieveCount(EntityName='account',Since=2026-01-01T00:00:00Z,Depth=");
    expect(restRequest(`${server}/`, "whoAmI", whoAmI, {}).url).toBe(`${server}/WhoAmI()`);

    // Only a parameter the description makes optional is left out.
    expect(() =>
      restRequest(
        `${server}/`,
        "retrieveCount",
        { ...count, optionalPathParameters: [] },
        {
          EntityName: "account",
          Depth: "Basic",
          Target: {},
        },
      ),
    ).toThrow("retrieveCount needs Since");
  });

  it("make a variable of the address an input of every method", () => {
    const description = parseDescription(csdl, "https://{environment}/api/data/v9.2/$metadata", {
      environment: "The environment's host.",
    });

    expect(description).toMatchObject({
      servers: [
        {
          url: "https://{environment}/api/data/v9.2",
          variables: {
            environment: { default: "environment", description: "The environment's host." },
          },
        },
      ],
    });

    const generated = generateOpenapi(
      description,
      { operations: { WhoAmI: { name: "whoAmI" } } },
      {
        name: "Example",
        className: "ExampleApi",
        result: "ExampleResult",
        properties: "ExampleProperties",
        typePrefix: "Example.Service.",
      },
      "",
    );

    expect(generated.files["src/api.ts"]).toMatch(
      /async whoAmI\(input: \{[\s\S]*environment: string;/,
    );
    expect(generated.files["src/schema.ts"]).toContain("https://{environment}/api/data/v9.2/");

    const whoAmI: RestOperation = {
      httpMethod: "GET",
      path: "/WhoAmI()",
      pathParameters: {},
      queryParameters: {},
      headerParameters: {},
      body: null,
      bodyRequired: false,
      response: "json",
      pageable: false,
    };

    const base = "https://{environment}/api/data/v9.2/";

    expect(restRequest(base, "whoAmI", whoAmI, { environment: "contoso.example.test" }).url).toBe(
      "https://contoso.example.test/api/data/v9.2/WhoAmI()",
    );

    // A variable holds a host, never a path or another address.
    for (const environment of ["contoso.example.test/other", "user@contoso.example.test", ""])
      expect(() => restRequest(base, "whoAmI", whoAmI, { environment })).toThrow("a host name");
    expect(() => restRequest(base, "whoAmI", whoAmI, {})).toThrow("needs environment");

    // A variable becomes an input, so its name must be one.
    expect(() =>
      generateOpenapi(
        parseDescription(csdl, "https://{environment-host}/api/data/v9.2/$metadata", {
          "environment-host": "The environment's host.",
        }),
        { operations: {} },
        {
          name: "Example",
          className: "ExampleApi",
          result: "ExampleResult",
          properties: "ExampleProperties",
        },
        "",
      ),
    ).toThrow("Server variable names are identifiers");
  });
});
