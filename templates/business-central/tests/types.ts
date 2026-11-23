// Compiled by `pnpm typecheck`: the results a consuming app sees, as template.md shows them.
import type BusinessCentral from "../src/app.ts";

declare const businessCentral: BusinessCentral;

export const examples = async () => {
  const environments = await businessCentral.listEnvironments();

  const environment =
    environments.status === "connected" ? environments.data.value?.[0]?.name : undefined;

  if (!environment) return;
  const companies = await businessCentral.listCompanies({ environment });
  const companyId = companies.status === "connected" ? companies.data.value?.[0]?.id : undefined;

  if (!companyId) return;

  const open = await businessCentral.listSalesInvoices({
    environment,
    companyId,
    $filter: "status eq 'Open'",
    $expand: "salesInvoiceLines",
    $top: 20,
  });

  if (open.status === "connected")
    for (const invoice of open.data.value ?? []) {
      const total: number | undefined = invoice.totalAmountIncludingTax;
      const quantities = invoice.salesInvoiceLines?.map((line) => line.quantity);
      void [invoice.number, invoice.customerName, total, quantities];
    }

  // A deep insert creates the invoice with its lines.
  const created = await businessCentral.createSalesInvoice({
    environment,
    companyId,
    body: {
      customerNumber: "10000",
      salesInvoiceLines: [{ lineType: "Item", lineObjectNumber: "1896-S", quantity: 3 }],
    },
  });

  if (created.status === "connected" && created.data.id) {
    const salesInvoiceId = created.data.id;

    const posted = await businessCentral.postSalesInvoice({
      environment,
      companyId,
      salesInvoiceId,
    });

    if (posted.resultType === "input_required") void posted.inputRequests.approve.message;

    const pdf = await businessCentral.downloadSalesInvoicePdf({
      environment,
      companyId,
      salesInvoiceId,
    });

    if (pdf.status === "connected" && "base64" in pdf.data)
      void [pdf.data.contentType, pdf.data.base64];
  }

  // A change names the version it was read at.
  const customer = await businessCentral.getCustomer({ environment, companyId, customerId: "c" });

  if (customer.status === "connected" && customer.data["@odata.etag"]) {
    const changed = await businessCentral.updateCustomer({
      environment,
      companyId,
      customerId: "c",
      etag: customer.data["@odata.etag"],
      body: { email: "accounts@example.com" },
    });

    if (changed.status === "business_central_error") void changed.error.code;
  }

  // @ts-expect-error A change needs the entity's version.
  await businessCentral.updateCustomer({ environment, companyId, customerId: "c", body: {} });
  // @ts-expect-error Every method names its environment.
  await businessCentral.listCustomers({ companyId });
  await businessCentral.createSalesInvoice({
    environment,
    companyId,
    // @ts-expect-error Amounts are numbers.
    body: { discountAmount: "5" },
  });
};
