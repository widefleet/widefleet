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
    service: "Teams",
    description:
      "Read and send chat messages, start chats, and read and post in your teams' channels.",
    account: "Microsoft account",
    user: name,
    connected: account,
    failed,
    missing,
    setup: [
      "Register a Microsoft application that supports the account types you use, and add the delegated permissions Chat.ReadWrite, ChatMessage.Send, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All and ChannelMessage.Send. Grant admin consent for ChannelMessage.Read.All.",
      `Add this web redirect URI: ${copyable(`${origin}/auth/callback/microsoft`)}`,
    ],
    approvals: approvalForm("Teams", level),
  });

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Teams", destination, cookies);
