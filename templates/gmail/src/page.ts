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
    service: "Gmail",
    description: "Read, search, send and organize email, drafts, labels and settings.",
    account: "Google account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Create a Google OAuth client of the type Web application and enable the Gmail API. The app requests full access to Gmail.",
      `Add this authorized redirect URI: ${copyable(`${origin}/auth/callback/google`)}`,
    ],
    approvals: approvalForm("Gmail", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Gmail", destination, cookies);
