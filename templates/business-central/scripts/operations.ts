// How the template generator offers Business Central's API v2.0: a company's
// customers, vendors, contacts, items, employees and projects, its sales and
// purchase documents with their lines, actions and PDFs, journals, customer
// payments, time registration, the general ledger, dimensions and
// attachments. Microsoft publishes no OpenAPI description of the API, so
// scripts/openapi.ts builds one from the AL source of the API pages and the
// API reference. This file lists the operations the template offers, by
// operation ID, with their method names. Operations that change data name the
// change they make, which decides when they ask the user first (see
// src/approval.ts). Posting and cancelling a document change it for good and
// count as updates; actions that email a document to the customer count as
// sending.
import { download, reference } from "./openapi.ts";

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source: reference,
  service: {
    name: "Business Central",
    className: "BusinessCentralApi",
    result: "BusinessCentralResult",
    properties: "BusinessCentralProperties",
  },
} as const;

// The description is built from the API pages' source and reference.
export { download };

export type Change = "create" | "update" | "delete" | "send";

// Business Central changes and deletes an entity only at the version the caller read.
const version = {
  etag: {
    name: "If-Match",
    description:
      "The entity's `@odata.etag` as last read. Business Central refuses the change when the entity changed since.",
    required: true,
  },
};

const update = { change: "update", headers: version } as const;

const remove = { change: "delete", headers: version } as const;

export const operations = {
  // Environments and companies
  "environments.list": { name: "listEnvironments" },
  "companies.list": { name: "listCompanies" },
  "companies.get": { name: "getCompany" },

  // Customers, vendors, contacts, items, employees and projects
  "customers.list": { name: "listCustomers" },
  "customers.get": { name: "getCustomer" },
  "customers.create": { name: "createCustomer", change: "create" },
  "customers.update": { name: "updateCustomer", ...update },
  "customers.delete": { name: "deleteCustomer", ...remove },
  "vendors.list": { name: "listVendors" },
  "vendors.get": { name: "getVendor" },
  "vendors.create": { name: "createVendor", change: "create" },
  "vendors.update": { name: "updateVendor", ...update },
  "vendors.delete": { name: "deleteVendor", ...remove },
  "contacts.list": { name: "listContacts" },
  "contacts.get": { name: "getContact" },
  "contacts.create": { name: "createContact", change: "create" },
  "contacts.update": { name: "updateContact", ...update },
  "contacts.delete": { name: "deleteContact", ...remove },
  "items.list": { name: "listItems" },
  "items.get": { name: "getItem" },
  "items.create": { name: "createItem", change: "create" },
  "items.update": { name: "updateItem", ...update },
  "items.delete": { name: "deleteItem", ...remove },
  "employees.list": { name: "listEmployees" },
  "employees.get": { name: "getEmployee" },
  "employees.create": { name: "createEmployee", change: "create" },
  "employees.update": { name: "updateEmployee", ...update },
  "employees.delete": { name: "deleteEmployee", ...remove },
  "projects.list": { name: "listProjects" },
  "projects.get": { name: "getProject" },
  "projects.create": { name: "createProject", change: "create" },
  "projects.update": { name: "updateProject", ...update },
  "projects.delete": { name: "deleteProject", ...remove },

  // Sales quotes
  "salesQuotes.list": { name: "listSalesQuotes" },
  "salesQuotes.get": { name: "getSalesQuote" },
  "salesQuotes.create": { name: "createSalesQuote", change: "create" },
  "salesQuotes.update": { name: "updateSalesQuote", ...update },
  "salesQuotes.delete": { name: "deleteSalesQuote", ...remove },
  "salesQuotes.salesQuoteLines.list": { name: "listSalesQuoteLines" },
  "salesQuotes.salesQuoteLines.create": { name: "createSalesQuoteLine", change: "create" },
  "salesQuoteLines.get": { name: "getSalesQuoteLine" },
  "salesQuoteLines.update": { name: "updateSalesQuoteLine", ...update },
  "salesQuoteLines.delete": { name: "deleteSalesQuoteLine", ...remove },
  "salesQuotes.makeInvoice": { name: "makeInvoiceFromSalesQuote", change: "update" },
  "salesQuotes.makeOrder": { name: "makeOrderFromSalesQuote", change: "update" },
  "salesQuotes.send": { name: "sendSalesQuote", change: "send" },
  "salesQuotes.pdfDocument.pdfDocumentContent": {
    name: "downloadSalesQuotePdf",
    description: "Download the sales quote as a PDF. Its bytes arrive as `base64`.",
  },

  // Sales orders
  "salesOrders.list": { name: "listSalesOrders" },
  "salesOrders.get": { name: "getSalesOrder" },
  "salesOrders.create": { name: "createSalesOrder", change: "create" },
  "salesOrders.update": { name: "updateSalesOrder", ...update },
  "salesOrders.delete": { name: "deleteSalesOrder", ...remove },
  "salesOrders.salesOrderLines.list": { name: "listSalesOrderLines" },
  "salesOrders.salesOrderLines.create": { name: "createSalesOrderLine", change: "create" },
  "salesOrderLines.get": { name: "getSalesOrderLine" },
  "salesOrderLines.update": { name: "updateSalesOrderLine", ...update },
  "salesOrderLines.delete": { name: "deleteSalesOrderLine", ...remove },
  "salesOrders.shipAndInvoice": { name: "shipAndInvoiceSalesOrder", change: "update" },
  "salesOrders.pdfDocument.pdfDocumentContent": {
    name: "downloadSalesOrderPdf",
    description: "Download the sales order as a PDF. Its bytes arrive as `base64`.",
  },

  // Sales invoices
  "salesInvoices.list": { name: "listSalesInvoices" },
  "salesInvoices.get": { name: "getSalesInvoice" },
  "salesInvoices.create": { name: "createSalesInvoice", change: "create" },
  "salesInvoices.update": { name: "updateSalesInvoice", ...update },
  "salesInvoices.delete": { name: "deleteSalesInvoice", ...remove },
  "salesInvoices.salesInvoiceLines.list": { name: "listSalesInvoiceLines" },
  "salesInvoices.salesInvoiceLines.create": { name: "createSalesInvoiceLine", change: "create" },
  "salesInvoiceLines.get": { name: "getSalesInvoiceLine" },
  "salesInvoiceLines.update": { name: "updateSalesInvoiceLine", ...update },
  "salesInvoiceLines.delete": { name: "deleteSalesInvoiceLine", ...remove },
  "salesInvoices.post": { name: "postSalesInvoice", change: "update" },
  "salesInvoices.postAndSend": { name: "postAndSendSalesInvoice", change: "send" },
  "salesInvoices.send": { name: "sendSalesInvoice", change: "send" },
  "salesInvoices.cancel": { name: "cancelSalesInvoice", change: "update" },
  "salesInvoices.cancelAndSend": { name: "cancelAndSendSalesInvoice", change: "send" },
  // A new draft credit memo; the invoice stays as it is.
  "salesInvoices.makeCorrectiveCreditMemo": { name: "makeCorrectiveCreditMemo", change: "create" },
  "salesInvoices.pdfDocument.pdfDocumentContent": {
    name: "downloadSalesInvoicePdf",
    description: "Download the sales invoice as a PDF. Its bytes arrive as `base64`.",
  },

  // Sales credit memos
  "salesCreditMemos.list": { name: "listSalesCreditMemos" },
  "salesCreditMemos.get": { name: "getSalesCreditMemo" },
  "salesCreditMemos.create": { name: "createSalesCreditMemo", change: "create" },
  "salesCreditMemos.update": { name: "updateSalesCreditMemo", ...update },
  "salesCreditMemos.delete": { name: "deleteSalesCreditMemo", ...remove },
  "salesCreditMemos.salesCreditMemoLines.list": { name: "listSalesCreditMemoLines" },
  "salesCreditMemos.salesCreditMemoLines.create": {
    name: "createSalesCreditMemoLine",
    change: "create",
  },
  "salesCreditMemoLines.get": { name: "getSalesCreditMemoLine" },
  "salesCreditMemoLines.update": { name: "updateSalesCreditMemoLine", ...update },
  "salesCreditMemoLines.delete": { name: "deleteSalesCreditMemoLine", ...remove },
  "salesCreditMemos.post": { name: "postSalesCreditMemo", change: "update" },
  "salesCreditMemos.postAndSend": { name: "postAndSendSalesCreditMemo", change: "send" },
  "salesCreditMemos.send": { name: "sendSalesCreditMemo", change: "send" },
  "salesCreditMemos.cancel": { name: "cancelSalesCreditMemo", change: "update" },
  "salesCreditMemos.cancelAndSend": { name: "cancelAndSendSalesCreditMemo", change: "send" },
  "salesCreditMemos.pdfDocument.pdfDocumentContent": {
    name: "downloadSalesCreditMemoPdf",
    description: "Download the sales credit memo as a PDF. Its bytes arrive as `base64`.",
  },

  // Purchase orders
  "purchaseOrders.list": { name: "listPurchaseOrders" },
  "purchaseOrders.get": { name: "getPurchaseOrder" },
  "purchaseOrders.create": { name: "createPurchaseOrder", change: "create" },
  "purchaseOrders.update": { name: "updatePurchaseOrder", ...update },
  "purchaseOrders.delete": { name: "deletePurchaseOrder", ...remove },
  "purchaseOrders.purchaseOrderLines.list": { name: "listPurchaseOrderLines" },
  "purchaseOrders.purchaseOrderLines.create": { name: "createPurchaseOrderLine", change: "create" },
  "purchaseOrderLines.get": { name: "getPurchaseOrderLine" },
  "purchaseOrderLines.update": { name: "updatePurchaseOrderLine", ...update },
  "purchaseOrderLines.delete": { name: "deletePurchaseOrderLine", ...remove },
  "purchaseOrders.receiveAndInvoice": { name: "receiveAndInvoicePurchaseOrder", change: "update" },
  "purchaseOrders.pdfDocument.pdfDocumentContent": {
    name: "downloadPurchaseOrderPdf",
    description: "Download the purchase order as a PDF. Its bytes arrive as `base64`.",
  },

  // Purchase invoices
  "purchaseInvoices.list": { name: "listPurchaseInvoices" },
  "purchaseInvoices.get": { name: "getPurchaseInvoice" },
  "purchaseInvoices.create": { name: "createPurchaseInvoice", change: "create" },
  "purchaseInvoices.update": { name: "updatePurchaseInvoice", ...update },
  "purchaseInvoices.delete": { name: "deletePurchaseInvoice", ...remove },
  "purchaseInvoices.purchaseInvoiceLines.list": { name: "listPurchaseInvoiceLines" },
  "purchaseInvoices.purchaseInvoiceLines.create": {
    name: "createPurchaseInvoiceLine",
    change: "create",
  },
  "purchaseInvoiceLines.get": { name: "getPurchaseInvoiceLine" },
  "purchaseInvoiceLines.update": { name: "updatePurchaseInvoiceLine", ...update },
  "purchaseInvoiceLines.delete": { name: "deletePurchaseInvoiceLine", ...remove },
  "purchaseInvoices.post": { name: "postPurchaseInvoice", change: "update" },
  "purchaseInvoices.pdfDocument.pdfDocumentContent": {
    name: "downloadPurchaseInvoicePdf",
    description: "Download the purchase invoice as a PDF. Its bytes arrive as `base64`.",
  },

  // General journals: lines are posted with their journal.
  "journals.list": { name: "listJournals" },
  "journals.get": { name: "getJournal" },
  "journals.journalLines.list": { name: "listJournalLines" },
  "journals.journalLines.create": { name: "createJournalLine", change: "create" },
  "journalLines.get": { name: "getJournalLine" },
  "journalLines.update": { name: "updateJournalLine", ...update },
  "journalLines.delete": { name: "deleteJournalLine", ...remove },
  "journals.post": { name: "postJournal", change: "update" },

  // Customer payments, entered in a customer payment journal
  "customerPaymentJournals.list": { name: "listCustomerPaymentJournals" },
  "customerPaymentJournals.get": { name: "getCustomerPaymentJournal" },
  "customerPaymentJournals.customerPayments.list": { name: "listCustomerPayments" },
  "customerPaymentJournals.customerPayments.create": {
    name: "createCustomerPayment",
    change: "create",
  },
  "customerPayments.get": { name: "getCustomerPayment" },
  "customerPayments.update": { name: "updateCustomerPayment", ...update },
  "customerPayments.delete": { name: "deleteCustomerPayment", ...remove },

  // Time registration
  "timeRegistrationEntries.list": { name: "listTimeRegistrationEntries" },
  "timeRegistrationEntries.get": { name: "getTimeRegistrationEntry" },
  "timeRegistrationEntries.create": { name: "createTimeRegistrationEntry", change: "create" },
  "timeRegistrationEntries.update": { name: "updateTimeRegistrationEntry", ...update },
  "timeRegistrationEntries.delete": { name: "deleteTimeRegistrationEntry", ...remove },

  // The general ledger and dimensions only read.
  "accounts.list": { name: "listAccounts" },
  "accounts.get": { name: "getAccount" },
  "generalLedgerEntries.list": { name: "listGeneralLedgerEntries" },
  "generalLedgerEntries.get": { name: "getGeneralLedgerEntry" },
  "dimensions.list": { name: "listDimensions" },
  "dimensions.get": { name: "getDimension" },
  "dimensionValues.list": { name: "listDimensionValues" },
  "dimensionValues.get": { name: "getDimensionValue" },

  // Attachments of documents and journal lines
  "attachments.list": {
    name: "listAttachments",
    description:
      "List the attachments of a record, such as a journal line or a document: filter by `parentId eq <record id>` and its `parentType`, such as `'Journal'` or `'Sales Invoice'`.",
  },
  "attachments.get": { name: "getAttachment" },
  "attachments.attachmentContent": {
    name: "downloadAttachment",
    description:
      "Download an attachment's content: text for text media types, and `base64` for others.",
  },
  "attachments.delete": { name: "deleteAttachment", ...remove },
};

// A document's lines can be expanded with `$expand` and created with the
// document, as Business Central's deep insert accepts them.
export const navigation = {
  SalesQuote: { salesQuoteLines: ["SalesQuoteLine"] },
  SalesOrder: { salesOrderLines: ["SalesOrderLine"] },
  SalesInvoice: { salesInvoiceLines: ["SalesInvoiceLine"] },
  SalesCreditMemo: { salesCreditMemoLines: ["SalesCreditMemoLine"] },
  PurchaseOrder: { purchaseOrderLines: ["PurchaseOrderLine"] },
  PurchaseInvoice: { purchaseInvoiceLines: ["PurchaseInvoiceLine"] },
};
