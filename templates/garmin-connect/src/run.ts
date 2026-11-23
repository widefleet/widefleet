import { keyConnection } from "./connection.ts";
import { binaryContent } from "./content.ts";
import type { Environment, Properties } from "./context.ts";
import { type Arguments, boundedJson, maximumResponseBytes } from "./input.ts";
import { restRequest } from "./rest.ts";
import type { GarminConnectResult } from "./results.ts";
import { base, operations } from "./schema.ts";

/** Props of a call. */
export type GarminConnectProperties = Properties;

/**
 * Runs one Garmin Connect Personal API operation for the current user. The
 * request is checked against the operation's parameters before anything is sent.
 */
export const run = async <T>(
  environment: Environment,
  properties: GarminConnectProperties,
  method: keyof typeof operations,
  input: Arguments,
): Promise<GarminConnectResult<T>> => {
  const operation = operations[method];
  const request = restRequest(base, method, operation, input);
  const sent = await keyConnection(environment, properties).send(request.url, request.init);

  if (sent.status !== "connected") return sent;
  const { response } = sent;

  if (response.status === 401)
    return { status: "reconnect_required", connectUrl: environment.WIDEFLEET_ORIGIN };

  if (response.status === 429)
    return { status: "rate_limited", retryAfter: response.headers.get("retry-after") };

  const tooLarge = { status: "too_large", maximumBytes: maximumResponseBytes } as const;

  // An activity's original file arrives as a ZIP archive.
  if (operation.response === "binary" && response.ok) {
    const content = await binaryContent(response);

    // SAFETY: the generated signature types binary results as BinaryContent.
    return content ? { status: "connected", data: content as T } : tooLarge;
  }

  const read = await boundedJson(response);

  if (read.status === "too_large") return tooLarge;

  if (response.ok)
    // SAFETY: Garmin answered with the result this operation describes, or no
    // content, which its generated signature types as T.
    return { status: "connected", data: read.body as T };

  return { status: "garmin_error", error: { status: response.status, body: read.body } };
};
