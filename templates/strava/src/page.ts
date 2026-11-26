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
<p class="muted">An administrator creates a Strava API application for this app before anyone can connect.</p>
<ol class="card steps">
<li>Create a Strava API application. The organization that registers it accepts Strava's API Agreement for it.</li>
<li>Set its Authorization Callback Domain to ${copyable(new URL(origin).hostname)}</li>
<li>Set ${secretNames(missing)} on this app's Secrets page in Widefleet.</li>
</ol></section>`;

  const connected = (name: string) => `<section><h2>Account</h2>
<div class="card row"><div class="status"><span class="dot" aria-hidden="true"></span><div><strong>${escapeHtml(name)}</strong><p class="muted small">Connected Strava account</p></div></div>
<div class="actions">${missing.length ? "" : '<form method="post" action="/connect"><button class="outline">Reconnect</button></form>'}<form method="post" action="/disconnect"><button class="ghost">Disconnect</button></form></div></div>
<p class="muted small note">Disconnecting deletes the saved tokens from this app. To revoke access, also remove it in your Strava account settings.</p></section>
${approvalForm(level)}`;

  const disconnected = `<section><div class="card stack"><p>Connect your Strava account so apps and agents can use Strava for you.</p>
<form method="post" action="/connect"><button class="primary">Connect Strava</button></form></div></section>`;

  return page(
    "Strava",
    `${heading("Strava", "Read your profile, activities, streams, clubs, gear, routes and segments, and create, upload and update activities.")}
${failed ? '<p class="alert" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? setup : ""}
${account ? connected(account) : missing.length ? "" : disconnected}`,
  );
};

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Strava", destination, cookies);
