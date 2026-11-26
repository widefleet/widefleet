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
    service: "GitHub",
    description:
      "Read and change repositories, issues, pull requests, discussions, projects and more.",
    account: "GitHub account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Register a GitHub OAuth app. The app requests read and write access to repositories, workflows and projects, read access to organizations, and access to your profile.",
      `Set this authorization callback URL: ${copyable(`${origin}/auth/callback/github`)}`,
    ],
    approvals: approvalForm("GitHub", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("GitHub", destination, cookies);
