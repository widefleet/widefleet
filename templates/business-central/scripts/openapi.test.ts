import { describe, expect, it } from "vitest";
import { openapiDescription, parsePage, parseReference } from "./openapi.ts";

// Synthetic sources in the forms of the API pages' AL and the API reference.
const invoices = `namespace Microsoft.API.V2;

page 30012 "APIV2 - Sales Invoices"
{
    APIVersion = 'v2.0';
    EntityCaption = 'Sales Invoice';
    EntitySetCaption = 'Sales Invoices';
    EntityName = 'salesInvoice';
    EntitySetName = 'salesInvoices';
    ODataKeyFields = Id;
    PageType = API;
    AboutText = 'Manages the company''s sales invoices.';

    layout
    {
        area(content)
        {
            repeater(Group)
            {
                field(id; Rec.Id)
                {
                    Caption = 'Id';
                    Editable = false;
                }
                field(number; Rec."No.")
                {
                    Caption = 'No.';
                    Editable = false;

                    trigger OnValidate()
                    begin
                        // A comment with a brace: {
                        RegisterFieldSet(Rec.FieldNo("No."));
                    end;
                }
                field("code"; Rec.Code)
                {
                    Caption = 'Code, as in {braces}';
                }
                part(salesInvoiceLines; "APIV2 - Sales Invoice Lines")
                {
                    EntityName = 'salesInvoiceLine';
                    EntitySetName = 'salesInvoiceLines';
                    SubPageLink = "Document Id" = field(Id);
                }
                part(pdfDocument; "APIV2 - PDF Document")
                {
                    Multiplicity = ZeroOrOne;
                    EntityName = 'pdfDocument';
                    EntitySetName = 'pdfDocument';
                }
            }
        }
    }

    [ServiceEnabled]
    [Caption('Posts the draft sales invoice')]
    [Scope('Cloud')]
    procedure Post(var ActionContext: WebServiceActionContext)
    begin
    end;
}
`;

const lines = `page 30043 "APIV2 - Sales Invoice Lines"
{
    APIVersion = 'v2.0';
    EntityCaption = 'Sales Invoice Line';
    EntitySetCaption = 'Sales Invoice Lines';
    EntityName = 'salesInvoiceLine';
    EntitySetName = 'salesInvoiceLines';
    PageType = API;
    DeleteAllowed = false;

    layout
    {
        area(content)
        {
            repeater(Group)
            {
                field(id; Rec.SystemId)
                {
                    Editable = false;
                }
                field(quantity; Rec.Quantity)
                {
                }
            }
        }
    }
}
`;

const pdf = `page 30056 "APIV2 - PDF Document"
{
    APIVersion = 'v2.0';
    EntityCaption = 'PDF Document';
    EntitySetCaption = 'PDF Document';
    Editable = false;
    EntityName = 'pdfDocument';
    EntitySetName = 'pdfDocument';
    PageType = API;

    layout
    {
        area(content)
        {
            repeater(Group)
            {
                field(id; Rec.Id) { }
                field(pdfDocumentContent; Rec.Content) { }
            }
        }
    }
}
`;

const automation = `page 5435 "APIV2 - Aut. Companies"
{
    APIGroup = 'automation';
    APIPublisher = 'microsoft';
    APIVersion = 'v2.0';
    EntityName = 'automationCompany';
    EntitySetName = 'automationCompanies';
    PageType = API;
}
`;

const reference = (
  entity: string,
  properties: string,
  navigation = "",
) => `# ${entity} resource type

Represents a ${entity} in [!INCLUDE[prod_short](../../../includes/prod_short.md)].

## Methods

| Method | Return Type|Description |
|:--------------------|:-----------|:-------------------------|
|[GET ${entity}](../api/dynamics_${entity}_get.md)|${entity}|Gets a ${entity} object.|

## Navigation

| Navigation |Return Type| Description |
|:----------|:----------|:-----------------|
${navigation}

## Properties

| Property           | Type   |Description     |
|:-------------------|:-------|:---------------|
${properties}

## JSON representation
`;

const references = {
  "dynamics_company.md": reference(
    "company",
    "|id|GUID|The unique ID of the company. Non-editable.|\n|name|string|The company's name.|",
    "|[salesInvoices](dynamics_salesinvoice.md)|salesInvoices |Gets the salesinvoices of the company.|\n|[salesInvoiceLines](dynamics_salesinvoiceline.md)|salesInvoiceLines |Gets the lines.|",
  ),
  "dynamics_salesinvoice.md": reference(
    "salesInvoice",
    "|id|GUID|The unique ID.|\n|number|string|The [number](https://example.test) of the invoice.|\n|code|string||",
  ),
  "dynamics_salesinvoiceline.md": reference(
    "salesInvoiceLine",
    "|id|GUID|The unique ID.|\n|quantity|decimal|The quantity.|",
  ),
  "dynamics_pdfDocument.md": reference(
    "pdfDocument",
    "|id|GUID|The unique ID.|\n|pdfDocumentContent|stream|The content of the PDF document.|",
  ),
};

const environments = `\`\`\`json
{
    "value": [
        {
            "aadTenantId": Guid, // ID of the Microsoft Entra tenant that owns the environment
            "name": string, // Environment name, unique within an application family
            "webClientLoginUrl": string // URL to login page of the environment
        }
    ]
}
\`\`\``;

const describeApi = () =>
  openapiDescription(
    [invoices, lines, pdf, automation],
    Object.fromEntries(
      Object.entries(references).map(([name, text]) => [name, parseReference(text)]),
    ),
    environments,
  );

describe("Business Central's API description", () => {
  it("reads API pages: fields, editability, subpages and bound actions", () => {
    expect(parsePage(invoices)).toEqual({
      page: "APIV2 - Sales Invoices",
      entityName: "salesInvoice",
      entitySetName: "salesInvoices",
      entityCaption: "Sales Invoice",
      entitySetCaption: "Sales Invoices",
      about: "Manages the company's sales invoices.",
      insert: true,
      modify: true,
      delete: true,
      fields: [
        { name: "id", editable: false },
        { name: "number", editable: false },
        { name: "code", editable: true },
      ],
      parts: [
        { name: "salesInvoiceLines", page: "APIV2 - Sales Invoice Lines", many: true },
        { name: "pdfDocument", page: "APIV2 - PDF Document", many: false },
      ],
      actions: [{ name: "Post", caption: "Posts the draft sales invoice" }],
    });
    expect(parsePage(pdf)).toMatchObject({ insert: false, modify: false, delete: false });
    // Pages of other API groups, such as automation, are not the standard API.
    expect(parsePage(automation)).toBeNull();
  });

  it("types properties as the reference does and marks fields Business Central fills", () => {
    const { components } = describeApi();

    expect(components.schemas["SalesInvoice"]).toEqual({
      type: "object",
      description: "Manages the company's sales invoices.",
      properties: {
        "@odata.etag": {
          type: "string",
          readOnly: true,
          description: "The entity's version. Pass it as `etag` to change or delete the entity.",
        },
        id: { type: "string", format: "uuid", description: "The unique ID.", readOnly: true },
        number: { type: "string", description: "The number of the invoice.", readOnly: true },
        code: { type: "string" },
        salesInvoiceLines: {
          type: "array",
          items: { $ref: "#/components/schemas/SalesInvoiceLine" },
          "x-ms-navigationProperty": true,
        },
        pdfDocument: {
          $ref: "#/components/schemas/PdfDocument",
          "x-ms-navigationProperty": true,
        },
      },
    });
    // Entities that cannot be written mark nothing; media content has its own address.
    expect(components.schemas["PdfDocument"]?.properties).toEqual({
      "@odata.etag": { type: "string", description: "The entity's version." },
      id: { type: "string", format: "uuid", description: "The unique ID." },
    });
    expect(components.schemas["Environment"]?.properties).toEqual({
      aadTenantId: {
        type: "string",
        format: "uuid",
        description: "ID of the Microsoft Entra tenant that owns the environment",
      },
      name: {
        type: "string",
        description: "Environment name, unique within an application family",
      },
      webClientLoginUrl: { type: "string", description: "URL to login page of the environment" },
    });
  });

  it("describes each company set, its subpages, actions and media", () => {
    const { paths } = describeApi();
    const company = "/v2.0/{environment}/api/v2.0/companies({companyId})";

    const operations = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => [
        operation.operationId,
        `${method.toUpperCase()} ${path.replace(company, "")}`,
      ]),
    );

    expect(Object.fromEntries(operations)).toEqual({
      "companies.list": "GET /v2.0/{environment}/api/v2.0/companies",
      "companies.get": "GET ",
      "salesInvoices.list": "GET /salesInvoices",
      "salesInvoices.create": "POST /salesInvoices",
      "salesInvoices.get": "GET /salesInvoices({salesInvoiceId})",
      "salesInvoices.update": "PATCH /salesInvoices({salesInvoiceId})",
      "salesInvoices.delete": "DELETE /salesInvoices({salesInvoiceId})",
      "salesInvoices.post": "POST /salesInvoices({salesInvoiceId})/Microsoft.NAV.post",
      // Lines are a company set too: below their invoice they are listed and created.
      "salesInvoices.salesInvoiceLines.list":
        "GET /salesInvoices({salesInvoiceId})/salesInvoiceLines",
      "salesInvoices.salesInvoiceLines.create":
        "POST /salesInvoices({salesInvoiceId})/salesInvoiceLines",
      "salesInvoices.pdfDocument.get": "GET /salesInvoices({salesInvoiceId})/pdfDocument",
      "salesInvoices.pdfDocument.pdfDocumentContent":
        "GET /salesInvoices({salesInvoiceId})/pdfDocument/pdfDocumentContent",
      "salesInvoiceLines.list": "GET /salesInvoiceLines",
      "salesInvoiceLines.create": "POST /salesInvoiceLines",
      "salesInvoiceLines.get": "GET /salesInvoiceLines({salesInvoiceLineId})",
      "salesInvoiceLines.update": "PATCH /salesInvoiceLines({salesInvoiceLineId})",
      "environments.list": "GET /environments/v1.2",
    });

    const action = paths[`${company}/salesInvoices({salesInvoiceId})/Microsoft.NAV.post`]?.["post"];

    expect(action?.summary).toBe("Posts the draft sales invoice.");
    expect(action?.responses).toEqual({ "204": { description: "No content" } });
    expect(paths[`${company}/salesInvoices`]?.["get"]?.["x-ms-pageable"]).toEqual({
      nextLinkName: "@odata.nextLink",
    });
    expect(
      paths[`${company}/salesInvoices({salesInvoiceId})/pdfDocument/pdfDocumentContent`]?.["get"]
        ?.responses["200"]?.content,
    ).toEqual({ "application/octet-stream": { schema: { type: "string", format: "binary" } } });
  });

  it("stops at types the reference does not define", () => {
    expect(() =>
      openapiDescription(
        [invoices],
        {
          ...Object.fromEntries(
            Object.entries(references).map(([name, text]) => [name, parseReference(text)]),
          ),
          "dynamics_salesinvoice.md": parseReference(
            reference("salesInvoice", "|id|GUID|The ID.|\n|number|currency|The number.|"),
          ),
        },
        environments,
      ),
    ).toThrow("SalesInvoice.number has the unknown type currency");
  });
});
