// How the template generator offers Qonto's Business API: the connected
// organization's accounts, transactions, transfers, cards, invoicing and team.
// This file lists the operations the template offers, by operation ID or, where
// Qonto gives none, by method and path, with their method names. Operations
// that change data name the change they make, which decides when they ask the
// user first (see src/approval.ts). Payments name `send`, so they ask unless the
// user's approval level is `none`. Qonto also asks for its own approval on the
// user's paired phone for payments to beneficiaries they have not trusted, which
// src/run.ts handles.
//
// Not offered: trusting beneficiaries and approving or declining requests,
// which would let a caller lift Qonto's own approvals; Embed partner and Sandbox
// operations; the OAuth endpoints and SCA sessions, which the template uses
// itself; and deprecated operations.
import { download, index } from "./openapi.ts";

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source: index,
  service: {
    name: "Qonto",
    className: "QontoApi",
    result: "QontoResult",
    properties: "QontoProperties",
  },
} as const;

// Qonto publishes the description one operation per documentation page.
export { download };

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  // Organization, business accounts and statements
  "GET /v2/organization": { name: "getOrganization" },
  listUserOrganizations: { name: "listUserOrganizations" },
  "GET /v2/subscription": { name: "getSubscription" },
  listBusinessAccounts: { name: "listBusinessAccounts" },
  getBusinessAccount: { name: "getBusinessAccount" },
  createBusinessAccount: { name: "createBusinessAccount", change: "create" },
  updateBusinessAccount: { name: "updateBusinessAccount", change: "update" },
  closeBusinessAccount: { name: "closeBusinessAccount", change: "delete" },
  downloadBusinessAccountIbanCertificate: { name: "downloadIbanCertificate" },
  get_statements: { name: "listStatements" },
  get_statement: { name: "getStatement" },

  // Transactions, labels and attachments
  "GET /v2/transactions": { name: "listTransactions" },
  "GET /v2/transactions/{id}": { name: "getTransaction" },
  "GET /v2/transactions/{id}/child_transaction_links": { name: "listChildTransactionLinks" },
  get_labels: { name: "listLabels" },
  "GET /v2/labels/{id}": { name: "getLabel" },
  "POST /v2/attachments": { name: "uploadAttachment", change: "create" },
  get_attachment: { name: "getAttachment" },
  "GET /v2/transactions/{id}/attachments": { name: "listTransactionAttachments" },
  "POST /v2/transactions/{id}/attachments": {
    name: "uploadTransactionAttachment",
    change: "create",
  },
  "DELETE /v2/transactions/{transaction_id}/attachments/{attachment_id}": {
    name: "removeTransactionAttachment",
    change: "delete",
  },
  "DELETE /v2/transactions/{id}/attachments": {
    name: "removeTransactionAttachments",
    change: "delete",
  },

  // Cash flow categories, scenarios and targets
  listCashFlowCategories: { name: "listCashFlowCategories" },
  createCashFlowCategory: { name: "createCashFlowCategory", change: "create" },
  createCashFlowSubcategory: { name: "createCashFlowSubcategory", change: "create" },
  updateCashFlowCategory: { name: "updateCashFlowCategory", change: "update" },
  deleteCashFlowCategory: { name: "deleteCashFlowCategory", change: "delete" },
  assignCashFlowCategory: { name: "assignCashFlowCategory", change: "update" },
  unassignCashFlowCategory: { name: "unassignCashFlowCategory", change: "update" },
  listCashFlowScenarios: { name: "listCashFlowScenarios" },
  createCashFlowScenario: { name: "createCashFlowScenario", change: "create" },
  updateCashFlowScenario: { name: "updateCashFlowScenario", change: "update" },
  deleteCashFlowScenario: { name: "deleteCashFlowScenario", change: "delete" },
  listCashFlowTargets: { name: "listCashFlowTargets" },
  upsertCashFlowTargets: { name: "setCashFlowTargets", change: "update" },
  deleteCashFlowTarget: { name: "deleteCashFlowTarget", change: "delete" },

  // SEPA beneficiaries; checking a payee only reads
  indexSepaBeneficiaries: { name: "listSepaBeneficiaries" },
  showSepaBeneficiary: { name: "getSepaBeneficiary" },
  createSepaBeneficiary: { name: "createSepaBeneficiary", change: "create" },
  updateSepaBeneficiary: { name: "updateSepaBeneficiary", change: "update" },
  deleteSepaBeneficiary: { name: "deleteSepaBeneficiary", change: "delete" },
  untrustSepaBeneficiaries: { name: "untrustSepaBeneficiaries", change: "update" },
  verifyPayee: { name: "verifyPayee", change: "read" },
  bulkVerifyPayee: { name: "verifyPayees", change: "read" },

  // SEPA transfers
  listSepaTransfers: { name: "listSepaTransfers" },
  getSepaTransfer: { name: "getSepaTransfer" },
  createSepaTransfer: { name: "createSepaTransfer", change: "send" },
  cancelSepaTransfer: { name: "cancelSepaTransfer", change: "delete" },
  downloadProofSepaTransfer: { name: "downloadSepaTransferProof", change: "read" },
  listSepaBulkTransfers: { name: "listSepaBulkTransfers" },
  getSepaBulkTransfer: { name: "getSepaBulkTransfer" },
  createSepaBulkTransfers: { name: "createSepaBulkTransfer", change: "send" },
  listSepaRecurringTransfers: { name: "listSepaRecurringTransfers" },
  getSepaRecurringTransfer: { name: "getSepaRecurringTransfer" },
  createSepaRecurringTransfer: { name: "createSepaRecurringTransfer", change: "send" },
  cancelSepaRecurringTransfer: { name: "cancelSepaRecurringTransfer", change: "delete" },

  // Internal and international transfers
  "POST /v2/internal_transfers": { name: "createInternalTransfer", change: "update" },
  checkEligibilityInternationalTransfer: { name: "checkInternationalTransferEligibility" },
  listCurrenciesInternationalTransfer: { name: "listInternationalTransferCurrencies" },
  getInternationalBeneficiaryByCurrency: { name: "listInternationalBeneficiaries" },
  listRequirementsForInternationalBeneficiary: {
    name: "listInternationalBeneficiaryRequirements",
    change: "read",
  },
  createInternationalBeneficiary: { name: "createInternationalBeneficiary", change: "create" },
  updateInternationalBeneficiary: { name: "updateInternationalBeneficiary", change: "update" },
  deleteInternationalBeneficiary: { name: "deleteInternationalBeneficiary", change: "delete" },
  createInternationalTransferQuote: { name: "createInternationalTransferQuote", change: "create" },
  listInternationalTransferRequirements: {
    name: "listInternationalTransferRequirements",
    change: "read",
  },
  listInternationalTransfers: { name: "listInternationalTransfers" },
  getInternationalTransfer: { name: "getInternationalTransfer" },
  createInternationalTransfer: { name: "createInternationalTransfer", change: "send" },

  // Requests an approver reviews in Qonto
  list_requests: { name: "listRequests" },
  "POST /v2/requests/transfers": { name: "createTransferRequest", change: "create" },
  "POST /v2/requests/multi_transfers": { name: "createMultiTransferRequest", change: "create" },
  "POST /v2/requests/flash_cards": { name: "createFlashCardRequest", change: "create" },
  "POST /v2/requests/virtual_cards": { name: "createVirtualCardRequest", change: "create" },

  // SEPA Direct Debit
  listDirectDebitCollections: { name: "listDirectDebitCollections" },
  getDirectDebitCollection: { name: "getDirectDebitCollection" },
  listDirectDebitMandates: { name: "listDirectDebitMandates" },
  getDirectDebitMandate: { name: "getDirectDebitMandate" },
  createDirectDebitMandate: { name: "createDirectDebitMandate", change: "create" },
  cancelDirectDebitMandate: { name: "cancelDirectDebitMandate", change: "delete" },
  listDirectDebitSubscriptions: { name: "listDirectDebitSubscriptions" },
  getDirectDebitSubscription: { name: "getDirectDebitSubscription" },
  createDirectDebitSubscription: { name: "createDirectDebitSubscription", change: "send" },

  // Cards
  "GET /v2/cards": { name: "listCards" },
  "GET /v2/cards/appearances": { name: "listCardAppearances" },
  "GET /v2/cards/{id}/data_view": { name: "getCardDataView" },
  "POST /v2/cards": { name: "createCard", change: "create" },
  "POST /v2/cards_bulk": { name: "createCards", change: "create" },
  "PATCH /v2/cards/{id}/limits": { name: "updateCardLimits", change: "update" },
  "PATCH /v2/cards/{id}/nickname": { name: "updateCardNickname", change: "update" },
  "PATCH /v2/cards/{id}/options": { name: "updateCardOptions", change: "update" },
  "PATCH /v2/cards/{id}/restrictions": { name: "updateCardRestrictions", change: "update" },
  "PUT /v2/cards/{id}/lock": { name: "lockCard", change: "update" },
  "PUT /v2/cards/{id}/unlock": { name: "unlockCard", change: "update" },
  "PUT /v2/cards/{id}/lost": { name: "reportCardLost", change: "delete" },
  "PUT /v2/cards/{id}/stolen": { name: "reportCardStolen", change: "delete" },
  "PUT /v2/cards/{id}/discard": { name: "discardCard", change: "delete" },

  // Clients and products
  "GET /v2/clients": {
    name: "listClients",
    // Qonto describes its filters as one object parameter; they are four
    // separate query parameters, each matching one field.
    parameters: [
      { name: "filter[]", in: "query", deprecated: true, schema: { type: "string" } },
      {
        name: "filter[name]",
        in: "query",
        description:
          "Clients whose name contains this text, of at least 2 characters, ignoring case and accents. An individual's or freelancer's name is their first and last name.",
        schema: { type: "string" },
      },
      {
        name: "filter[email]",
        in: "query",
        description: "Clients with this email address, ignoring case.",
        schema: { type: "string" },
      },
      {
        name: "filter[vat_number]",
        in: "query",
        description: "Clients with this VAT number, ignoring case.",
        schema: { type: "string" },
      },
      {
        name: "filter[tax_identification_number]",
        in: "query",
        description: "Clients with this tax identification number, ignoring case.",
        schema: { type: "string" },
      },
    ],
  },
  "GET /v2/clients/{id}": { name: "getClient" },
  "POST /v2/clients": { name: "createClient", change: "create" },
  "PATCH /v2/clients/{id}": { name: "updateClient", change: "update" },
  "DELETE /v2/clients/{id}": { name: "deleteClient", change: "delete" },
  "GET /v2/products": { name: "listProducts" },
  "GET /v2/products/{id}": { name: "getProduct" },
  "POST /v2/products": { name: "createProduct", change: "create" },
  "DELETE /v2/products/{id}": { name: "deleteProduct", change: "delete" },

  // Client invoices, uploads and credit notes
  list_client_invoices: { name: "listClientInvoices" },
  get_client_invoice: { name: "getClientInvoice" },
  create_client_invoice: { name: "createClientInvoice", change: "create" },
  patch_client_invoice: { name: "updateClientInvoice", change: "update" },
  delete_client_invoice: { name: "deleteClientInvoice", change: "delete" },
  finalize_client_invoice: { name: "finalizeClientInvoice", change: "update" },
  cancel_client_invoice: { name: "cancelClientInvoice", change: "update" },
  mark_client_invoice_as_paid: { name: "markClientInvoicePaid", change: "update" },
  unmark_as_paid_client_invoice: { name: "unmarkClientInvoicePaid", change: "update" },
  send_client_invoice: { name: "sendClientInvoice", change: "send" },
  send_client_invoice_by_e_invoice: { name: "sendClientInvoiceByEInvoice", change: "send" },
  bulk_import_client_invoices: { name: "importClientInvoices", change: "create" },
  create_client_invoice_upload: { name: "createClientInvoiceUpload", change: "create" },
  get_client_invoice_upload: { name: "getClientInvoiceUpload" },
  list_credit_notes: { name: "listCreditNotes" },
  get_credit_note: { name: "getCreditNote" },
  download_credit_note: { name: "downloadCreditNote" },
  create_credit_note: { name: "createCreditNote", change: "create" },
  send_credit_note: { name: "sendCreditNote", change: "send" },

  // Quotes, recurring invoices, reminders and invoicing settings
  list_quotes: { name: "listQuotes" },
  get_quote: { name: "getQuote" },
  create_quote: { name: "createQuote", change: "create" },
  update_quote: { name: "updateQuote", change: "update" },
  delete_quote: { name: "deleteQuote", change: "delete" },
  send_quote: { name: "sendQuote", change: "send" },
  list_recurring_invoices: { name: "listRecurringInvoices" },
  get_recurring_invoice: { name: "getRecurringInvoice" },
  validate_recurring_invoice: { name: "validateRecurringInvoice", change: "read" },
  create_recurring_invoice: { name: "createRecurringInvoice", change: "create" },
  update_recurring_invoice: { name: "updateRecurringInvoice", change: "update" },
  suspend_recurring_invoice: { name: "suspendRecurringInvoice", change: "update" },
  reactivate_recurring_invoice: { name: "reactivateRecurringInvoice", change: "update" },
  cancel_recurring_invoice: { name: "cancelRecurringInvoice", change: "delete" },
  list_reminders: { name: "listReminders" },
  get_reminder: { name: "getReminder" },
  "POST /v2/reminders": { name: "createReminder", change: "create" },
  update_reminder: { name: "replaceReminder", change: "update" },
  delete_reminder: { name: "deleteReminder", change: "delete" },
  get_invoicing_settings: { name: "getInvoicingSettings" },
  update_invoicing_settings: { name: "updateInvoicingSettings", change: "update" },
  get_einvoicing_settings: { name: "getEInvoicingSettings" },

  // Supplier invoices and suppliers
  list_supplier_invoices: { name: "listSupplierInvoices" },
  get_supplier_invoice: { name: "getSupplierInvoice" },
  bulk_create_supplier_invoices: { name: "createSupplierInvoices", change: "create" },
  mark_supplier_invoice_as_paid: { name: "markSupplierInvoicePaid", change: "update" },
  unmark_supplier_invoice_as_paid: { name: "unmarkSupplierInvoicePaid", change: "update" },
  reject_supplier_invoice: { name: "rejectSupplierInvoice", change: "update" },
  search_suppliers: { name: "searchSuppliers", change: "read" },
  get_supplier: { name: "getSupplier" },
  create_supplier: { name: "createSupplier", change: "create" },
  update_supplier: { name: "updateSupplier", change: "update" },

  // Payment links and terminals
  getPaymentLinkConnection: { name: "getPaymentLinkConnection" },
  createPaymentLinkConnection: { name: "connectPaymentLinks", change: "create" },
  getPaymentLinkPaymentMethods: { name: "listPaymentLinkPaymentMethods" },
  getPaymentLinks: { name: "listPaymentLinks" },
  getPaymentLink: { name: "getPaymentLink" },
  getPaymentLinkPayments: { name: "listPaymentLinkPayments" },
  createPaymentLink: { name: "createPaymentLink", change: "create" },
  deactivatePaymentLink: { name: "deactivatePaymentLink", change: "update" },
  listTerminals: { name: "listTerminals" },
  getTerminalPayment: { name: "getTerminalPayment" },
  createTerminalPayment: { name: "createTerminalPayment", change: "send" },

  // Team: memberships and teams
  "GET /v2/membership": { name: "getMembership" },
  "GET /v2/memberships": { name: "listMemberships" },
  "POST /v2/memberships/invite_employee_or_accountant": {
    name: "inviteMember",
    change: "send",
  },
  "GET /v2/teams": { name: "listTeams" },
  "POST /v2/teams": { name: "createTeam", change: "create" },
  "PATCH /v2/teams/{id}": { name: "updateTeam", change: "update" },

  // Insurance contracts
  "GET /v2/insurance_contracts/{id}": { name: "getInsuranceContract" },
  "POST /v2/insurance_contracts": { name: "createInsuranceContract", change: "create" },
  "PATCH /v2/insurance_contracts/{id}": { name: "updateInsuranceContract", change: "update" },
  "POST /v2/insurance_contracts/{id}/attachments": {
    name: "uploadInsuranceContractDocument",
    change: "create",
  },
  "DELETE /v2/insurance_contracts/{id}/attachments/{attachment_id}": {
    name: "removeInsuranceContractDocument",
    change: "delete",
  },

  // Webhook subscriptions
  listWebhookSubscriptions: { name: "listWebhookSubscriptions" },
  getWebhookSubscription: { name: "getWebhookSubscription" },
  createWebhookSubscription: { name: "createWebhookSubscription", change: "create" },
  updateWebhookSubscription: { name: "updateWebhookSubscription", change: "update" },
  deleteWebhookSubscription: { name: "deleteWebhookSubscription", change: "delete" },

  // Ends the application's access to the organization; Qonto rejects the saved tokens afterwards.
  revokeOAuthConsents: { name: "revokeAccess", change: "delete" },
} satisfies Record<
  string,
  {
    name: string;
    change?: Change | "read";
    description?: string;
    parameters?: readonly object[];
  }
>;
