const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

// The platform's form-action 'self' policy also constrains form redirects in
// Chromium. Finish the POST here, then navigate from this document to Google.
export const authorizationPage = (url: string, cookies: string[]) => {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

  for (const cookie of cookies) headers.append("set-cookie", cookie);

  const destination = escapeHtml(url);

  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="0;url=${destination}">
<title>Continue to Google</title></head><body>
<p>Opening Google to connect your account. <a href="${destination}">Continue to Google</a></p>
</body></html>`,
    { headers },
  );
};

// The runtime's no-referrer default makes form POSTs send Origin: null. Keep the
// same-origin check working without sending referrer information to other origins.
export const connectionPage = (name: string, accountId: string | null, failed: boolean) =>
  new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="same-origin">
<title>Connect Gmail</title><style>
*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#202124;font:16px/1.6 system-ui,sans-serif}
main{max-width:540px;margin:10vh auto;padding:32px}h1{font-size:30px;line-height:1.2;letter-spacing:-.7px}
.muted{color:#666;font-size:14px}.notice{border-left:3px solid #b45309;padding:8px 16px;background:#fffbeb}
form{margin:16px 0}button{font:inherit;border:1px solid #ddd;border-radius:7px;padding:10px 18px;cursor:pointer;background:white}
.primary{background:#202124;color:white;border-color:#202124}code{overflow-wrap:anywhere}
</style></head><body><main><p class="muted">Personal connection</p>
<h1>Gmail ${accountId ? "connected" : "connection"}</h1>
<p>Widefleet user: ${escapeHtml(name)}</p>
${failed ? '<p class="notice" role="alert">The connection could not be completed. Try again. To switch Google accounts, disconnect the current account first.</p>' : ""}
${accountId ? `<p>Your Google account <code>${escapeHtml(accountId)}</code> is linked.</p>` : "<p>Connect your Google account to read Gmail through Widefleet apps.</p>"}
<p>Connected apps use your Gmail account when you use them. Other users connect their own accounts.</p>
<form method="post" action="/connect"><button class="primary">${accountId ? "Reconnect Google account" : "Connect Google account"}</button></form>
${accountId ? '<form method="post" action="/disconnect"><button>Disconnect</button></form><p class="muted">Disconnect removes the saved tokens from this app. It does not revoke access in your Google account settings.</p>' : ""}
<p class="muted">After connecting, return to your app and retry its Gmail action.</p>
</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
