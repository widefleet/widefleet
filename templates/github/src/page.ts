const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const page = (title: string, content: string, cookies: string[] = []) => {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "same-origin",
  });

  for (const cookie of cookies) headers.append("set-cookie", cookie);

  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="referrer" content="same-origin"><title>${escapeHtml(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#202124;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:10vh auto;padding:32px}h1{font-size:30px;line-height:1.2;letter-spacing:-.7px}.muted{color:#666;font-size:14px}.notice{border-left:3px solid #b45309;padding:8px 16px;background:#fffbeb}form{margin:16px 0}button{font:inherit;border:1px solid #ddd;border-radius:7px;padding:10px 18px;cursor:pointer;background:white}.primary{background:#202124;color:white;border-color:#202124}code{overflow-wrap:anywhere}</style>
</head><body><main>${content}</main></body></html>`,
    { headers },
  );
};

export const connectionPage = (
  name: string,
  account: string | null,
  missing: string[],
  origin: string,
  failed: boolean,
) =>
  page(
    "Connect GitHub",
    `
<p class="muted">Personal connection</p><h1>GitHub ${account ? "connected" : "connection"}</h1>
<p>Widefleet user: ${escapeHtml(name)}</p><p>List repositories and issues and read repository files using your GitHub account.</p>
${failed ? '<p class="notice" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? `<p class="notice">Setup is required before accounts can be connected.</p>${missing.some((key) => key !== "AUTH_SECRET") ? "<p>Register a GitHub OAuth app and set the callback URL below. The repo scope used for private repositories also grants write access; this connector only exposes read methods.</p>" : ""}<p>AUTH_SECRET must be a random secret of at least 32 characters.</p><p>Ask your administrator to set these app secrets: ${missing.map((key) => `<code>${escapeHtml(key)}</code>`).join(", ")}.</p>${missing.some((key) => key !== "AUTH_SECRET") ? `<p>OAuth callback URL: <code>${escapeHtml(`${origin}/auth/callback/github`)}</code></p>` : ""}` : `<p>${account ? `Your account <code>${escapeHtml(account)}</code> is linked.` : "Connect your account to use it through Widefleet apps."}</p><p>Connected apps use your account when you use them. Other users connect their own accounts.</p><form method="post" action="/connect"><button class="primary">${account ? "Reconnect account" : "Connect account"}</button></form>`}
${account ? '<form method="post" action="/disconnect"><button>Disconnect</button></form><p class="muted">Disconnect removes the saved tokens from this app. It does not revoke access in your provider account settings.</p>' : ""}
<p class="muted">After connecting, return to your app and retry its action.</p>`,
  );

export const authorizationPage = (destination: string, cookies: string[]) => {
  const url = escapeHtml(destination);

  // Chromium's form-action policy also constrains form redirects. Complete the
  // POST in a document, then navigate to the provider from that document.
  return page(
    "Continue to GitHub",
    `<meta http-equiv="refresh" content="0;url=${url}"><p>Opening GitHub to connect your account. <a href="${url}">Continue</a></p>`,
    cookies,
  );
};
