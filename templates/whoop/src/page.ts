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
    service: "WHOOP",
    description: "Read your profile, body measurements, cycles, recoveries, sleeps and workouts.",
    account: "WHOOP account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Create a WHOOP developer app with the scopes read:profile, read:body_measurement, read:cycles, read:recovery, read:sleep and read:workout. The organization that registers it accepts WHOOP's API Terms of Use for it.",
      `Add this redirect URL: ${copyable(`${origin}/auth/callback/whoop`)}`,
    ],
    approvals: approvalForm("WHOOP", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("WHOOP", destination, cookies);
