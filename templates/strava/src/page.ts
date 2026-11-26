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
    service: "Strava",
    description:
      "Read your profile, activities, streams, clubs, gear, routes and segments, and create, upload and update activities.",
    account: "Strava account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Create a Strava API application. The organization that registers it accepts Strava's API Agreement for it.",
      `Set its Authorization Callback Domain to ${copyable(new URL(origin).hostname)}`,
    ],
    approvals: approvalForm("Strava", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Strava", destination, cookies);
