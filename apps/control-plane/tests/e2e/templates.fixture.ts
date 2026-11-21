import { existsSync } from "node:fs";
import { templateRepository } from "../template-repository.fixture.ts";

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  if (
    url.href ===
    "https://raw.githubusercontent.com/widefleet/widefleet/main/templates/unavailable/template.md"
  )
    return new Response(null, { status: 503 });

  // A test creates this file to take the template list offline for its duration.
  const outage = process.env["TEMPLATE_OUTAGE"];

  if (
    outage &&
    url.href === "https://api.github.com/repos/widefleet/widefleet/contents/templates?ref=main" &&
    existsSync(outage)
  )
    return new Response(null, { status: 503 });

  return (await templateRepository(url)) ?? originalFetch(input, init);
};
