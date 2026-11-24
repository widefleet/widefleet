// Qonto publishes the Business API's OpenAPI description one operation per
// page of its documentation: each reference page ends with a complete OpenAPI
// document for its operation and the components it uses. The documentation's
// index lists the pages. `download` reads every Business API page and returns
// their documents, which the generator joins into one description.

/** The index of Qonto's documentation, which lists every reference page. */
export const index = "https://docs.qonto.com/llms.txt";

const pages = /https:\/\/docs\.qonto\.com\/api-reference\/business-api\/[^\s)]+\.md/g;

// An operation's document, after the page's heading for it, such as
// ````yaml POST /v2/sepa/transfers. Webhook pages describe events, not operations.
const document = /^````yaml (?:get|put|post|patch|delete) \/\S*\n([\s\S]*?)\n````$/im;

const text = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);

  return response.text();
};

/** The OpenAPI document of every operation page, as YAML text. */
export const download = async () => {
  const urls = [...new Set((await text(index)).match(pages))];
  const documents: string[] = [];

  // A few pages at a time, so the documentation site is not flooded.
  for (let start = 0; start < urls.length; start += 8)
    for (const page of await Promise.all(urls.slice(start, start + 8).map(text))) {
      const found = document.exec(page)?.[1];

      if (found) documents.push(found);
    }

  if (!documents.length)
    throw new Error("Qonto's reference pages no longer hold OpenAPI documents");

  return documents;
};
