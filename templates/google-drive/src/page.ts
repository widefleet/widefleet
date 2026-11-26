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
    service: "Google Drive",
    description:
      "Find, read, upload, organize and share files, folders and shared drives, with comments and revisions.",
    account: "Google account",
    connected: account,
    failed,
    missing,
    setup: [
      "Create a Google OAuth client of the type Web application and enable the Google Drive API. The app requests full access to Google Drive.",
      `Add this authorized redirect URI: ${copyable(`${origin}/auth/callback/google`)}`,
    ],
    approvals: approvalForm("Google Drive", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Google Drive", destination, cookies);
