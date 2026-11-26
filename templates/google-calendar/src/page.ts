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
    service: "Google Calendar",
    description:
      "Read, create and change events, calendars, sharing and settings, and find free time.",
    account: "Google account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Create a Google OAuth client of the type Web application and enable the Google Calendar API. The app requests full access to Google Calendar.",
      `Add this authorized redirect URI: ${copyable(`${origin}/auth/callback/google`)}`,
    ],
    approvals: approvalForm("Google Calendar", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Google Calendar", destination, cookies);
