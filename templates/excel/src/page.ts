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
    service: "Excel",
    description:
      "Find workbooks, read and write ranges, and work with worksheets, tables, named ranges and charts.",
    account: "Microsoft account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Register a Microsoft application that supports the account types you use, and add the delegated permission Files.ReadWrite.All.",
      `Add this web redirect URI: ${copyable(`${origin}/auth/callback/microsoft`)}`,
    ],
    approvals: approvalForm("Excel", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Excel", destination, cookies);
