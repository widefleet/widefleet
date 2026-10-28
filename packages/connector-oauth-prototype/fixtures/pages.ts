export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? "",
  );

export const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font:15px/1.55 system-ui,sans-serif;color:#e4e4e7;background:#141416}*{box-sizing:border-box}body{margin:0;padding:48px 24px}main{max-width:820px;margin:auto}h1{font-size:30px;letter-spacing:-.7px;margin:16px 0}p{color:#a1a1aa}a{color:#b7a5fc;text-underline-offset:4px}nav{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:22px 0}.label{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#a1a1aa}.panel{border:1px solid #333337;border-radius:12px;background:#1c1c20;padding:24px;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.grid .panel{margin:0}button{font:inherit;background:#c2b1ff;border:0;border-radius:7px;color:#201638;padding:9px 16px;cursor:pointer}button.secondary{background:#303036;color:#e4e4e7}form{display:inline-block;margin:8px 10px 8px 0}small{font-size:12px;color:#a1a1aa}code{font-size:12px}ul{padding-left:20px}.success{color:#74d4b2}.notice{border-left:3px solid #a894e6;padding-left:14px}hr{border:0;border-top:1px solid #333337;margin:28px 0}
  </style></head><body><main><div class="label">Lokaler OAuth-Versuch · Better Auth + D1</div>${body}</main></body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
