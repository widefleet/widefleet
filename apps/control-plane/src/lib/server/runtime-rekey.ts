import * as contract from "@platform/contracts";
import { z } from "zod";

/** The app runtime's management path that rewrites one page of its storage. */
export const runtimeRekeyPath = "/.well-known/widefleet/rekey";

/**
 * Sends one page request body to the app runtime's management endpoint. Node
 * and Workers bindings return their own Response types.
 */
export type RuntimeRekeyRequest = (
  body: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const rekeyResponse = z.object({ result: contract.runtimeRekeyPage });

/**
 * Rewrites runtime storage under the active key version, page by page. New
 * values are always sealed under the active version, so a pass without
 * unreadable values or conflicts leaves every value under it.
 */
export const rekeyRuntime = async (request: RuntimeRekeyRequest) => {
  const total = { current: 0, rewritten: 0, unreadable: 0, conflicts: 0 };
  let cursor: string | null = null;

  do {
    const response = await request(JSON.stringify(cursor ? { cursor } : {}));

    if (!response.ok)
      throw new Error(`The app runtime could not rewrite its storage (status ${response.status})`);

    const page = rekeyResponse.parse(JSON.parse(await response.text())).result;

    total.current += page.current;
    total.rewritten += page.rewritten;
    total.unreadable += page.unreadable;
    total.conflicts += page.conflicts;
    cursor = page.cursor;
  } while (cursor);

  return total;
};
