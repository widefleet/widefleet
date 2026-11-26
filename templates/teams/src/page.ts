import type { ApprovalLevel } from "./approval.ts";
import { approvalForm } from "./approval-page.ts";
import {
  authorizationPage as continuePage,
  copyable,
  escapeHtml,
  heading,
  page,
  secretNames,
} from "./layout.ts";

/** The app's page: setup until the OAuth client is set, then the account and approvals. */
export const connectionPage = (
  account: string | null,
  missing: string[],
  origin: string,
  failed: boolean,
  level: ApprovalLevel,
) => {
  const setup = `<section><h2>Finish setup</h2>
<p class="muted">An administrator registers a Microsoft application for this app before anyone can connect.</p>
<ol class="card steps">
<li>Register a Microsoft application that supports the account types you use, and add the delegated permissions Chat.ReadWrite, ChatMessage.Send, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All and ChannelMessage.Send. Grant admin consent for ChannelMessage.Read.All.</li>
<li>Add this web redirect URI: ${copyable(`${origin}/auth/callback/microsoft`)}</li>
<li>Set ${secretNames(missing)} on this app's Secrets page in Widefleet.</li>
</ol></section>`;

  const connected = (name: string) => `<section><h2>Account</h2>
<div class="card row"><div class="status"><span class="dot" aria-hidden="true"></span><div><strong>${escapeHtml(name)}</strong><p class="muted small">Connected Microsoft account</p></div></div>
<div class="actions">${missing.length ? "" : '<form method="post" action="/connect"><button class="outline">Reconnect</button></form>'}<form method="post" action="/disconnect"><button class="ghost">Disconnect</button></form></div></div></section>
${approvalForm(level)}`;

  const disconnected = `<section><div class="card stack"><p>Connect your Microsoft account so apps and agents can use Teams for you.</p>
<form method="post" action="/connect"><button class="primary">Connect Teams</button></form></div></section>`;

  return page(
    "Teams",
    `${heading("Teams", "Read and send chat messages, start chats, and read and post in your teams' channels.")}
${failed ? '<p class="alert" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? setup : ""}
${account ? connected(account) : missing.length ? "" : disconnected}`,
  );
};

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Teams", destination, cookies);
