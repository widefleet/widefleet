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
<p class="muted">An administrator adds a Google OAuth client to this app before anyone can connect.</p>
<ol class="card steps">
<li>Create a Google OAuth client of the type Web application and enable the Google Drive API. The app requests full access to Google Drive.</li>
<li>Add this authorized redirect URI: ${copyable(`${origin}/auth/callback/google`)}</li>
<li>Set ${secretNames(missing)} on this app's Secrets page in Widefleet.</li>
</ol></section>`;

  const connected = (name: string) => `<section><h2>Account</h2>
<div class="card row"><div class="status"><span class="dot" aria-hidden="true"></span><div><strong>${escapeHtml(name)}</strong><p class="muted small">Connected Google account</p></div></div>
<div class="actions">${missing.length ? "" : '<form method="post" action="/connect"><button class="outline">Reconnect</button></form>'}<form method="post" action="/disconnect"><button class="ghost">Disconnect</button></form></div></div></section>
${approvalForm(level)}`;

  const disconnected = `<section><div class="card stack"><p>Connect your Google account so apps and agents can use Google Drive for you.</p>
<form method="post" action="/connect"><button class="primary">Connect Google Drive</button></form></div></section>`;

  return page(
    "Google Drive",
    `${heading("Google Drive", "Find, read, upload, organize and share files, folders and shared drives, with comments and revisions.")}
${failed ? '<p class="alert" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? setup : ""}
${account ? connected(account) : missing.length ? "" : disconnected}`,
  );
};

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Google Drive", destination, cookies);
