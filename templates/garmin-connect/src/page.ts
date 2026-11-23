const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** The user's saved key, as the connection page describes it. */
export type SavedKeyState =
  | { status: "none" }
  | { status: "connected"; displayName: string | null; savedAt: number }
  | { status: "rejected"; savedAt: number };

/** Why the last key could not be saved. */
export type SaveError = "rejected" | "unavailable";

const page = (title: string, content: string) =>
  new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="same-origin"><link rel="icon" href="/favicon.svg"><title>${escapeHtml(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#202124;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:10vh auto;padding:32px}h1{font-size:30px;line-height:1.2;letter-spacing:-.7px}.muted{color:#666;font-size:14px}.notice{border-left:3px solid #b45309;padding:8px 16px;background:#fffbeb}form{margin:16px 0}label{display:block;font-weight:600;margin-bottom:6px}input{display:block;width:100%;font:inherit;border:1px solid #ddd;border-radius:7px;padding:10px 12px;margin-bottom:12px;background:white}button{font:inherit;border:1px solid #ddd;border-radius:7px;padding:10px 18px;cursor:pointer;background:white}.primary{background:#202124;color:white;border-color:#202124}code{overflow-wrap:anywhere}</style>
</head><body><main>${content}</main></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "same-origin",
      },
    },
  );

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

const errors: Record<SaveError, string> = {
  rejected:
    "Garmin did not accept this key. Check that you copied the whole key, or create a new one.",
  unavailable: "Garmin could not be reached to check the key. Try again.",
};

export const connectionPage = (
  name: string,
  key: SavedKeyState,
  ticket: string | null,
  error: SaveError | null,
) =>
  page(
    "Garmin Connect",
    `
<p class="muted">Personal connection</p><h1>Garmin Connect ${key.status === "connected" ? "connected" : "connection"}</h1>
<p>Widefleet user: ${escapeHtml(name)}</p><p>Use your own Garmin Connect data through Garmin's Personal API: activities and their files, sleep, heart rate, HRV, Body Battery, stress, steps, VO2 max, weight, nutrition and more.</p>
${error ? `<p class="notice" role="alert">${errors[error]}</p>` : ""}
${
  key.status === "connected"
    ? `<p>${key.displayName ? `Your account <code>${escapeHtml(key.displayName)}</code> is connected` : "Your account is connected"} with the Personal API key you saved on ${day(key.savedAt)}.</p>`
    : key.status === "rejected"
      ? `<p class="notice">Garmin no longer accepts the key you saved on ${day(key.savedAt)}. It expired or was deleted. Create a new key and save it here.</p>`
      : "<p>Connect your Garmin account with a Personal API key.</p>"
}
<form method="post" action="/connect"><label for="key">${key.status === "none" ? "Personal API key" : "New Personal API key"}</label><input id="key" name="key" type="password" autocomplete="off" spellcheck="false" required>${ticket ? `<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">` : ""}<button class="primary">${key.status === "none" ? "Connect" : "Replace key"}</button></form>
<p class="muted">Create a key on the <a href="https://connect.garmin.com/app/settings/personalApiToken">Personal API Key page</a> of Garmin Connect. Garmin shows it only once. It expires after the period you choose, and Garmin emails you about a week before; then create a new key and save it here. The key is stored encrypted and never shown again.</p>
${key.status === "none" ? "" : '<form method="post" action="/disconnect"><button>Disconnect</button></form><p class="muted">Disconnect removes the saved key from this app. To revoke the key itself, delete it on Garmin Connect.</p>'}
<p class="muted">Other users connect their own Garmin accounts. After connecting, return to your app and retry its action.</p>`,
  );

/** Ends a saved connection on this app's page and navigates back to Widefleet. */
export const returnPage = (destination: string) => {
  const url = escapeHtml(destination);

  return page(
    "Garmin Connect",
    `<meta http-equiv="refresh" content="0;url=${url}"><p>Your Garmin account is connected. <a href="${url}">Return to Widefleet</a></p>`,
  );
};
