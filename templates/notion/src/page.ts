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
<p class="muted">An administrator creates a Notion OAuth integration for this app before anyone can connect.</p>
<ol class="card steps">
<li>In Notion's Developer portal, create a connection with the authentication method OAuth, installable in your workspaces.</li>
<li>Add this redirect URI: ${copyable(`${origin}/auth/callback/notion`)}</li>
<li>On its Configuration tab, select every content, comment and agent capability and user information with email addresses.</li>
<li>Set ${secretNames(missing)} on this app's Secrets page in Widefleet.</li>
</ol></section>`;

  const connected = (name: string) => `<section><h2>Account</h2>
<div class="card row"><div class="status"><span class="dot" aria-hidden="true"></span><div><strong>${escapeHtml(name)}</strong><p class="muted small">Connected Notion account</p></div></div>
<div class="actions">${missing.length ? "" : '<form method="post" action="/connect"><button class="outline">Reconnect</button></form>'}<form method="post" action="/disconnect"><button class="ghost">Disconnect</button></form></div></div></section>
${approvalForm(level)}`;

  const disconnected = `<section><div class="card stack"><p>Connect your Notion account so apps and agents can use Notion for you. Notion then asks which pages to share.</p>
<form method="post" action="/connect"><button class="primary">Connect Notion</button></form></div></section>`;

  return page(
    "Notion",
    `${heading("Notion", "Read and write pages, databases, comments, files and Custom Agent chats.")}
${failed ? '<p class="alert" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? setup : ""}
${account ? connected(account) : missing.length ? "" : disconnected}`,
  );
};

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Notion", destination, cookies);
