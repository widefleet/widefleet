import type { ApprovalLevel } from "./approval.ts";
import { approvalForm } from "./approval-page.ts";
import { authorizationPage as continuePage, copyable, oauthConnectionPage } from "./layout.ts";

export const connectionPage = (
  account: string | null,
  missing: string[],
  origin: string,
  failed: boolean,
  level: ApprovalLevel,
) =>
  oauthConnectionPage({
    service: "Linear",
    description: "Read and change issues, projects, comments, documents and more.",
    account: "Linear account",
    connected: account,
    failed,
    missing,
    setup: [
      "Create a Linear OAuth application. The app requests read and write access.",
      `Add this callback URL: ${copyable(`${origin}/auth/callback/linear`)}`,
    ],
    approvals: approvalForm("Linear", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Linear", destination, cookies);
