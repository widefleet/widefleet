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
    service: "Outlook",
    description:
      "Read, draft and send email, plan meetings and manage events, contacts and mailbox settings.",
    account: "Microsoft account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Register a Microsoft application that supports the account types you use, and add the delegated permissions Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, Contacts.ReadWrite and MailboxSettings.ReadWrite.",
      `Add this web redirect URI: ${copyable(`${origin}/auth/callback/microsoft`)}`,
    ],
    approvals: approvalForm("Outlook", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Outlook", destination, cookies);
