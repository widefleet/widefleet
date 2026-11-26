// This app's look, in Widefleet's colors.

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

// Widefleet's colors, so a template's page reads as part of Widefleet in light and dark.
const styles = `
:root{color-scheme:light dark;--background:oklch(.985 .002 275);--foreground:oklch(.25 .015 275);--muted:oklch(.52 .01 275);--card:oklch(1 0 0);--border:oklch(.91 .004 275);--hover:oklch(.965 .003 275);--primary:oklch(.53 .17 278);--primary-foreground:oklch(.985 0 0);--ring:oklch(.6 .15 278);--destructive:oklch(.577 .245 27.325);--success:oklch(.62 .15 155)}
@media (prefers-color-scheme:dark){:root{--background:oklch(.185 .009 275);--foreground:oklch(.94 .004 275);--muted:oklch(.708 .005 275);--card:oklch(.215 .009 275);--border:oklch(1 0 0/10%);--hover:oklch(.255 .009 275);--primary:oklch(.72 .13 278);--primary-foreground:oklch(.205 0 0);--ring:oklch(.72 .13 278);--destructive:oklch(.704 .191 22.216);--success:oklch(.75 .15 155)}}
*{box-sizing:border-box}
body{margin:0;min-width:320px;background:var(--background);color:var(--foreground);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:12vh 16px 48px}
p,h1,h2,ol{margin:0}
a{color:inherit;text-underline-offset:3px}
code{font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.small{font-size:13px}
header{display:flex;gap:14px;align-items:flex-start;margin-bottom:28px}
header img{width:44px;height:44px;flex:none;padding:8px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
h1{font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.01em;margin-bottom:2px}
h2{font-size:14px;font-weight:600}
section+section{margin-top:32px}
.card{margin-top:12px;border:1px solid var(--border);border-radius:12px;background:var(--card);padding:16px}
.stack{display:grid;gap:12px;justify-items:start}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px 16px;flex-wrap:wrap}
.status{display:flex;align-items:center;gap:10px;min-width:0}
.status strong{font-weight:500;overflow-wrap:anywhere}
.dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--success)}
.actions{display:flex;gap:4px}
.note{margin-top:8px}
.alert{margin-bottom:20px;border:1px solid color-mix(in oklch,var(--destructive) 35%,transparent);border-radius:10px;background:color-mix(in oklch,var(--destructive) 7%,transparent);padding:10px 14px}
.steps{padding:16px 16px 16px 38px}
.steps li{padding-left:4px}
.steps li+li{margin-top:10px}
.value{display:block;margin-top:6px;border:1px solid var(--border);border-radius:8px;background:var(--hover);padding:6px 10px}
form{margin:0}
label.field{display:block;font-weight:500;margin-bottom:6px}
input[type=password],input[type=text]{display:block;width:100%;height:36px;font:inherit;color:inherit;border:1px solid var(--border);border-radius:8px;background:var(--background);padding:0 10px;margin-bottom:12px}
button{height:32px;font:inherit;font-weight:500;color:inherit;border:1px solid transparent;border-radius:8px;background:none;padding:0 12px;cursor:pointer;transition:background-color .15s,border-color .15s}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.primary{background:var(--primary);color:var(--primary-foreground)}
.primary:hover{background:color-mix(in oklch,var(--primary) 85%,var(--background))}
.outline{border-color:var(--border);background:var(--card)}
.outline:hover,.ghost:hover{background:var(--hover)}
fieldset{min-width:0;border:0;margin:0;padding:0}
legend{padding:0}
.options{margin-top:12px;overflow:hidden;border:1px solid var(--border);border-radius:12px;background:var(--card)}
.options label{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;cursor:pointer}
.options label>span{display:grid;gap:2px}
.options label+label{border-top:1px solid var(--border)}
.options label:hover{background:var(--hover)}
input[type=radio]{margin:4px 0 0;flex:none;accent-color:var(--primary)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);border-radius:8px;background:var(--foreground);color:var(--background);padding:10px 16px}
.toast[hidden]{display:none}
@media (prefers-reduced-motion:reduce){button{transition:none}}`;

/** A page of this app, in Widefleet's look. */
export const page = (title: string, content: string, cookies: string[] = []) => {
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
<style>${styles}</style>
</head><body><main>${content}</main></body></html>`,
    { headers },
  );
};

/** The service's logo and name, and what a connection lets apps do with it. */
export const heading = (service: string, description: string) =>
  `<header><img src="/favicon.svg" alt=""><div><h1>${escapeHtml(service)}</h1><p class="muted">${description}</p></div></header>`;

/** A value to copy into the provider's settings, such as a callback URL. */
export const copyable = (value: string) => `<code class="value">${escapeHtml(value)}</code>`;

/** The secrets still to set, as code. */
export const secretNames = (missing: string[]) =>
  missing.map((key) => `<code>${escapeHtml(key)}</code>`).join(" and ");

/** Opens the provider from a document, so the form's POST completes first. */
export const authorizationPage = (service: string, destination: string, cookies: string[]) => {
  const url = escapeHtml(destination);

  // Chromium's form-action policy also constrains form redirects. Complete the
  // POST in a document, then navigate to the provider from that document.
  return page(
    `Continue to ${service}`,
    `<meta http-equiv="refresh" content="0;url=${url}"><p>Opening ${escapeHtml(service)} to connect your account. <a href="${url}">Continue</a></p>`,
    cookies,
  );
};
