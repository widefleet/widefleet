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
    service: "OneDrive",
    description: "Browse, search, upload, move, share and restore files and folders.",
    account: "Microsoft account",
    connected: account,
    failed,
    missing,
    setup: [
      "Register a Microsoft application that supports the account types you use, and add the delegated permission Files.ReadWrite.All.",
      `Add this web redirect URI: ${copyable(`${origin}/auth/callback/microsoft`)}`,
    ],
    approvals: approvalForm("OneDrive", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("OneDrive", destination, cookies);
