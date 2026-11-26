import { escapeHtml, heading, page } from "./layout.ts";

/** The user's saved key, as the connection page describes it. */
export type SavedKeyState =
  | { status: "none" }
  | { status: "connected"; displayName: string | null; savedAt: number }
  | { status: "rejected"; savedAt: number };

/** Why the last key could not be saved. */
export type SaveError = "rejected" | "unavailable";

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

const errors: Record<SaveError, string> = {
  rejected:
    "Garmin did not accept this key. Check that you copied the whole key, or create a new one.",
  unavailable: "Garmin could not be reached to check the key. Try again.",
};

export const connectionPage = (
  key: SavedKeyState,
  ticket: string | null,
  error: SaveError | null,
) => {
  const form = `<form method="post" action="/connect" class="card"><label class="field" for="key">${key.status === "none" ? "Personal API key" : "New Personal API key"}</label><input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required>${ticket ? `<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">` : ""}<button class="${key.status === "connected" ? "outline" : "primary"}">${key.status === "none" ? "Connect Garmin Connect" : "Replace key"}</button></form>
<p class="muted small note">Create a key on the <a href="https://connect.garmin.com/app/settings/personalApiToken">Personal API Key page</a> of Garmin Connect. Garmin shows it only once and emails you about a week before it expires. The key is stored encrypted and never shown again.</p>`;

  const account =
    key.status === "none"
      ? ""
      : `<section><h2>Account</h2>
<div class="card row"><div class="status">${key.status === "connected" ? '<span class="dot" aria-hidden="true"></span>' : ""}<div><strong>${escapeHtml((key.status === "connected" && key.displayName) || "Garmin account")}</strong><p class="muted small">${key.status === "connected" ? `Connected with the key saved on ${day(key.savedAt)}` : `The key saved on ${day(key.savedAt)} no longer works`}</p></div></div>
<form method="post" action="/disconnect"><button class="ghost">Disconnect</button></form></div>
<p class="muted small note">Disconnecting deletes the saved key from this app. To revoke the key itself, delete it on Garmin Connect.</p></section>`;

  return page(
    "Garmin Connect",
    `${heading("Garmin Connect", "Read activities and their files, sleep, heart rate, HRV, Body Battery, stress, steps, VO2 max, weight, nutrition and more.")}
${error ? `<p class="alert" role="alert">${errors[error]}</p>` : key.status === "rejected" ? `<p class="alert" role="alert">Garmin no longer accepts the key you saved on ${day(key.savedAt)}. It expired or was deleted. Create a new key and save it here.</p>` : ""}
${account}
<section>${key.status === "connected" ? "<h2>Replace key</h2>" : key.status === "none" ? "<p>Connect your Garmin account with a Personal API key so apps and agents can read your data for you.</p>" : "<h2>New key</h2>"}${form}</section>`,
  );
};

/** Ends a saved connection on this app's page and navigates back to Widefleet. */
export const returnPage = (destination: string) => {
  const url = escapeHtml(destination);

  return page(
    "Garmin Connect",
    `<meta http-equiv="refresh" content="0;url=${url}"><p>Your Garmin account is connected. <a href="${url}">Return to Widefleet</a></p>`,
  );
};
