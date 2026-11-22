import { type ApprovalLevel, approvalLevels, levelDescriptions } from "./approval.ts";

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
<meta name="referrer" content="same-origin"><link rel="icon" href="/favicon.svg"><title>${escapeHtml(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#202124;font:16px/1.6 system-ui,sans-serif}main{max-width:640px;margin:10vh auto;padding:32px}h1{font-size:30px;line-height:1.2;letter-spacing:-.7px}.muted{color:#666;font-size:14px}.notice{border-left:3px solid #b45309;padding:8px 16px;background:#fffbeb}fieldset{border:0;margin:24px 0;padding:0}legend{font-weight:600;margin-bottom:8px;padding:0}input[type=radio]{margin:0}label{display:flex;gap:10px;align-items:center;padding:6px 0;cursor:pointer}.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#202124;color:white;border-radius:7px;padding:10px 18px;font-size:14px}.toast[hidden]{display:none}form{margin:16px 0}button{font:inherit;border:1px solid #ddd;border-radius:7px;padding:10px 18px;cursor:pointer;background:white}.primary{background:#202124;color:white;border-color:#202124}code{overflow-wrap:anywhere}</style>
</head><body><main>${content}</main></body></html>`,
    { headers },
  );
};

// Saves a new level at once and restores the previous one if saving fails.
const approvalForm = (level: ApprovalLevel) => `
<fieldset id="approval"><legend>Before Linear changes run</legend>
${approvalLevels.map((option) => `<label><input type="radio" name="level" value="${option}"${option === level ? " checked" : ""}> ${escapeHtml(levelDescriptions[option])}</label>`).join("")}
<p class="muted">Applies when apps and agents change Linear data with your account. Reading never asks.</p></fieldset>
<p class="toast" role="status" hidden></p>
<script>
const form = document.getElementById("approval");
const toast = document.querySelector(".toast");
let saved = form.querySelector("input:checked").value;
let latest = saved;
let saving = Promise.resolve();
const restore = () => {
  latest = saved;
  form.querySelector(\`input[value="\${saved}"]\`).checked = true;
  toast.textContent = "The approval level could not be saved. Try again.";
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 4000);
};
// Saves run one after another and each sends the latest choice, so the stored
// level always ends as the one the page shows.
form.addEventListener("change", (event) => {
  latest = event.target.value;
  saving = saving.then(async () => {
    const level = latest;
    if (level === saved) return;
    try {
      const response = await fetch("/approval-level", { method: "POST", body: new URLSearchParams({ level }) });
      if (response.ok) {
        saved = level;
        return;
      }
    } catch {}
    restore();
  });
});
</script>`;

export const connectionPage = (
  name: string,
  account: string | null,
  missing: string[],
  origin: string,
  failed: boolean,
  level: ApprovalLevel,
) =>
  page(
    "Connect Linear",
    `
<p class="muted">Personal connection</p><h1>Linear ${account ? "connected" : "connection"}</h1>
<p>Widefleet user: ${escapeHtml(name)}</p><p>Use your Linear workspace through Linear's API: read and change issues, projects, comments, documents and more.</p>
${failed ? '<p class="notice" role="alert">The connection could not be completed. Try again. To switch accounts, disconnect the current account first.</p>' : ""}
${missing.length ? `<p class="notice">Setup is required before accounts can be connected.</p><p>Create a Linear OAuth application and set the callback URL below. The connector requests read and write access.</p><p>Ask your administrator to set these app secrets: ${missing.map((key) => `<code>${escapeHtml(key)}</code>`).join(", ")}.</p><p>OAuth callback URL: <code>${escapeHtml(`${origin}/auth/callback/linear`)}</code></p>` : `<p>${account ? `Your account <code>${escapeHtml(account)}</code> is linked.` : "Connect your account to use it through Widefleet apps."}</p><p>Connected apps use your account when you use them. Other users connect their own accounts.</p><form method="post" action="/connect"><button class="primary">${account ? "Reconnect account" : "Connect account"}</button></form>`}
${account ? approvalForm(level) : ""}
${account ? '<form method="post" action="/disconnect"><button>Disconnect</button></form><p class="muted">Disconnect removes the saved tokens from this app.</p>' : ""}
<p class="muted">After connecting, return to your app and retry its action.</p>`,
  );

export const authorizationPage = (destination: string, cookies: string[]) => {
  const url = escapeHtml(destination);

  // Chromium's form-action policy also constrains form redirects. Complete the
  // POST in a document, then navigate to the provider from that document.
  return page(
    "Continue to Linear",
    `<meta http-equiv="refresh" content="0;url=${url}"><p>Opening Linear to connect your account. <a href="${url}">Continue</a></p>`,
    cookies,
  );
};
