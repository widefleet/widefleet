// The trusted parent applies the policy to both assets and Worker responses.
// Browser origins share one list; backend grants never widen this header.
// Frame ancestors come from the organization's embedding configuration, not the app.
export const browserPolicy = (
  response: Response,
  origins: string[],
  frameAncestors: string[] = [],
  allowBrowserWorkers = false,
) => {
  const allowed = ["'self'", ...origins].join(" ");

  const policy = [
    `default-src ${allowed}`,
    `script-src ${allowed} 'unsafe-inline'`,
    `style-src ${allowed} 'unsafe-inline'`,
    `connect-src ${allowed}`,
    `img-src ${allowed} data: blob:`,
    `font-src ${allowed} data:`,
    `media-src ${allowed} blob:`,
    `form-action ${allowed}`,
    allowBrowserWorkers ? "worker-src 'self'" : "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors ${["'self'", ...frameAncestors].join(" ")}`,
  ].join("; ");

  const guarded = new Response(response.body, response);
  guarded.headers.set("content-security-policy", policy);

  return guarded;
};
