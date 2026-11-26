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
    service: "Google Sheets",
    description:
      "Read and write cell values, create spreadsheets, and change sheets, formatting and charts.",
    account: "Google account",
    connected: account,
    failed,
    missing,
    setup: [
      "Create a Google OAuth client of the type Web application and enable the Google Sheets API. The app requests access to your spreadsheets.",
      `Add this authorized redirect URI: ${copyable(`${origin}/auth/callback/google`)}`,
    ],
    approvals: approvalForm("Google Sheets", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Google Sheets", destination, cookies);
