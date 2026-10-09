// The trusted parent applies the policy to both assets and Worker responses.
// Browser origins share one list; backend grants never widen this header.
export const browserPolicy = (response: Response, origins: string[]) => {
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
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join("; ");

  const guarded = new Response(response.body, response);
  guarded.headers.set("content-security-policy", policy);

  return guarded;
};
