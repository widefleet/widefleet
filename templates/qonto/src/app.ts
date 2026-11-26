import { WorkerEntrypoint } from "cloudflare:workers";
import { QontoApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Qonto organization through Qonto's Business API. Each
 * offered operation is a method. Reading never asks; changes ask the user first
 * according to their approval level, and Qonto asks for its own approval on the
 * user's paired phone where it requires one, such as a payment to a beneficiary
 * the organization has not trusted.
 *
 * @remarks
 * Inputs and results keep Qonto's field names. Lists take `page` and `per_page`
 * and answer with a `meta` object whose `next_page` names the next page. A SEPA
 * transfer first checks the payee with `verifyPayee`; a transfer above the
 * organization's payment policy returns `payment_policy_approval_required`, so
 * send it with `createTransferRequest` for an approver instead.
 *
 * A payment Qonto protects returns the question `approveInQonto`: the person
 * approves it in the Qonto app within 15 minutes and confirms, and the call
 * completes the payment. A refusal returns `rejected_in_qonto`.
 *
 * Files such as IBAN certificates and transfer proofs return with their
 * `contentType`; uploads such as `uploadAttachment` take `{ mimeType, base64
 * }`. `revokeAccess` ends the app's access in Qonto and removes the connection.
 *
 * @example
 * ```ts
 * const transactions = await env.QONTO.listTransactions({
 *   iban: "FR7616798000010000004321396",
 *   "status[]": ["completed"],
 *   per_page: 50,
 * });
 * if (transactions.status === "connected") {
 *   for (const transaction of transactions.data.transactions ?? []) {
 *     console.log(transaction.settled_at, transaction.label, transaction.amount);
 *   }
 * }
 * ```
 */
export default class Qonto extends QontoApi {
  /** Check account setup and linking. Connect the Qonto account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  /** The current user's approval level, which decides when changes ask first. */
  async approvalLevel() {
    return readApprovalLevel(this.env, this.ctx.props);
  }

  /**
   * Set when the current user is asked before changes run. Asking more takes
   * effect at once; asking less asks the user to confirm.
   */
  async setApprovalLevel(input: { level: ApprovalLevel }) {
    return changeApprovalLevel("Qonto", this.env, this.ctx.props, input);
  }

  /**
   * End the app's access to the organization in Qonto, then remove the saved
   * connection, since Qonto rejects its tokens afterwards. Asks the user first
   * unless their approval level is `none`.
   */
  override async revokeAccess(input: Record<string, never> = {}) {
    const connection = accountConnection(this.env, this.ctx.props);
    // The account whose access ends: the one connected when the request is sent.
    const status = await connection.status();
    const result = await super.revokeAccess(input);

    if (result.status === "connected" && status.status === "connected")
      await connection.forget(status.accountId);

    return result;
  }

  override async fetch(request: Request) {
    return (
      (await saveApprovalLevel(this.env, this.ctx.props, request)) ??
      accountConnection(this.env, this.ctx.props).fetch(request)
    );
  }
}

/** Personal account controls used by Widefleet's My connections page. */
export class UserConnection extends WorkerEntrypoint<Environment, Properties> {
  async status() {
    return accountConnection(this.env, this.ctx.props).personalStatus();
  }

  async prepare(input: { completionUrl: string }) {
    return accountConnection(this.env, this.ctx.props).prepare(input);
  }

  async disconnect() {
    return accountConnection(this.env, this.ctx.props).disconnect();
  }
}
