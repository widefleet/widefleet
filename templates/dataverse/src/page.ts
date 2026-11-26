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

/** A Dataverse environment the user can open. */
export interface EnvironmentListing {
  name: string;
  /** The environment's host, such as `contoso.api.crm4.dynamics.com`, which methods take. */
  environment: string;
  /** Whether the user is a system administrator there. */
  administrator: boolean;
}

// The environments the user can open, and the command an administrator runs
// once for each the app may reach.
const environmentList = (environments: EnvironmentListing[] | null) =>
  `<section><h2>Environments</h2>${
    environments === null
      ? '<p class="card muted">Your environments could not be listed. Reload the page to try again, or reconnect.</p>'
      : environments.length
        ? `<p class="muted">Methods take the environment's host as <code>environment</code>. An administrator allows the app to reach each environment once.</p>
<ul class="card steps">${environments
            .map(
              (listing) =>
                `<li><strong>${escapeHtml(listing.name)}</strong>${listing.administrator ? ' <span class="muted small">· administrator</span>' : ""}${copyable(`widefleet network allow https://${listing.environment}`)}</li>`,
            )
            .join("")}</ul>`
        : '<p class="card muted">Your account has no Dataverse environment you can open.</p>'
  }</section>`;

/** The app's page: setup until the OAuth client is set, then the account, environments and approvals. */
export const connectionPage = (
  account: string | null,
  missing: string[],
  origin: string,
  failed: boolean,
  level: ApprovalLevel,
  environments: EnvironmentListing[] | null,
) => {
  const setup = `<section><h2>Finish setup</h2>
<p class="muted">An administrator registers a Microsoft application for this app before anyone can connect.</p>
<ol class="card steps">
<li>Register a Microsoft application for accounts in any organizational directory, and add the delegated Dynamics CRM permission user_impersonation.</li>
<li>Add this web redirect URI: ${copyable(`${origin}/auth/callback/microsoft`)}</li>
<li>Set ${secretNames(missing)} on this app's Secrets page in Widefleet.</li>
</ol></section>`;

  const connected = (name: string) => `<section><h2>Account</h2>
<div class="card row"><div class="status"><span class="dot" aria-hidden="true"></span><div><strong>${escapeHtml(name)}</strong><p class="muted small">Connected Microsoft account</p></div></div>
<div class="actions">${missing.length ? "" : '<form method="post" action="/connect"><button class="outline">Reconnect</button></form>'}<form method="post" action="/disconnect"><button class="ghost">Disconnect</button></form></div></div></section>
${environmentList(environments)}
${approvalForm(level)}`;

  const disconnected = `<section><div class="card stack"><p>Connect your Microsoft work account so apps and agents can use Dataverse for you, with your security roles.</p>
<form method="post" action="/connect"><button class="primary">Connect Dataverse</button></form></div></section>`;

  return page(
    "Dataverse",
    `${heading("Dataverse", "Query and change the rows of any table, create tables, columns and security roles, and call actions and functions.")}
${failed ? '<p class="alert" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? setup : ""}
${account ? connected(account) : missing.length ? "" : disconnected}`,
  );
};

export const authorizationPage = (destination: string, cookies: string[]) =>
  continuePage("Microsoft", destination, cookies);
