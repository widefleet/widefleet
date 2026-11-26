import type { ApprovalLevel } from "./approval.ts";
import { approvalForm } from "./approval-page.ts";
import { authorizationPage as continuePage, copyable, oauthConnectionPage } from "./layout.ts";

export const connectionPage = (
  name: string,
  account: string | null,
  missing: string[],
  origin: string,
  failed: boolean,
  level: ApprovalLevel,
) =>
  oauthConnectionPage({
    service: "Qonto",
    description:
      "Work with accounts, transactions, transfers, cards, invoicing and team. Payments to beneficiaries your organization has not trusted still need your approval in the Qonto app on your paired phone.",
    account: "Qonto account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Create an app in Qonto's Developer Portal for the use case <em>Automate your business operations</em>.",
      `Add this redirect URL: ${copyable(`${origin}/auth/callback/qonto`)}`,
    ],
    connectNote: "Qonto asks you to choose the organization to connect.",
    approvals: approvalForm("Qonto", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Qonto", destination, cookies);
