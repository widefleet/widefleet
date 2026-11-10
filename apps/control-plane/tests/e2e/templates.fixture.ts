import { templateRepository } from "../template-repository.fixture.ts";

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  if (
    url.href ===
    "https://raw.githubusercontent.com/widefleet/widefleet/main/templates/unavailable/template.md"
  )
    return new Response(null, { status: 503 });

  return (await templateRepository(url)) ?? originalFetch(input, init);
};
