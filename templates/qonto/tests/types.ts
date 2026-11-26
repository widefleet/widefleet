// Compiled by `pnpm typecheck`: the results a consuming app sees.
import type Qonto from "../src/app.ts";

declare const qonto: Qonto;

export const examples = async () => {
  const transactions = await qonto.listTransactions({
    iban: "FR7616798000010000004321396",
    "status[]": ["completed"],
    per_page: 50,
  });

  if (transactions.status === "connected") {
    for (const transaction of transactions.data.transactions ?? []) {
      const amount: number | undefined = transaction.amount;
      void amount;
    }

    // A later page continues at the page the answer names.
    const next = transactions.data.meta?.next_page;

    if (next) await qonto.listTransactions({ iban: "FR7616798000010000004321396", page: next });
  }

  const transfer = await qonto.createSepaTransfer({
    body: {
      vop_proof_token: "proof",
      transfer: {
        beneficiary_id: "beneficiary",
        bank_account_id: "account",
        reference: "Invoice 42",
        amount: "120.00",
      },
    },
  });

  // Widefleet's question before the change, or Qonto's approval on the paired phone.
  if (transfer.resultType === "input_required")
    void ("approve" in transfer.inputRequests
      ? transfer.inputRequests.approve.message
      : transfer.inputRequests.approveInQonto.message);

  if (transfer.status === "qonto_error")
    for (const error of transfer.error.errors) void [error.code, transfer.error.traceId];

  if (transfer.status === "rejected_in_qonto") void transfer;

  const certificate = await qonto.downloadIbanCertificate({ id: "account" });

  if (certificate.status === "connected") void certificate.data;

  // @ts-expect-error A transfer needs its body.
  await qonto.createSepaTransfer({});
  // @ts-expect-error Pages are numbers.
  await qonto.listTransactions({ page: "2" });
};
