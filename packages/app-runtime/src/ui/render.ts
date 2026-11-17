import { render } from "svelte/server";
import Document from "./Document.svelte";
import type { McpPage } from "./pages.ts";

export const mcpPage = (page: McpPage, headers = new Headers(), status = 200) => {
  const nonce = crypto.randomUUID();
  const { body } = render(Document, { props: { page, nonce } });
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  // Same-origin form posts need Origin for CSRF checks; external redirects still omit Referer.
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    // form-action also constrains redirects. OAuth validates provider and client destinations.
    `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
  );

  return new Response(`<!doctype html>${body}`, { status, headers });
};
