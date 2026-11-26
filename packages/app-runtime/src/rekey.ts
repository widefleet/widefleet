import { runtimeRekeyInput, runtimeRekeyPage } from "@platform/contracts";
import { base64url } from "jose";
import { z } from "zod";
import { openAppKey, parseAppKey, sealAppKey } from "./keys.ts";
import { open, seal, sealedUnderActiveVersion } from "./secrets.ts";
import type { ParentEnvironment } from "./types.ts";

// Seals stored runtime values again under the active key version, one bounded
// page per request. Every value is opened first, also one that names the active
// version. A write succeeds only if the object is still the one read, so a value
// written meanwhile, such as a prepared snapshot or a rotated ring, is never
// replaced with an older one, and a repeated page changes nothing. Bearer values
// are held by clients, not stored, so they are not rewritten.

const pageSize = 50;

// The RS256 ring. The earlier Ed25519 ring at `workload/signing-keys.json` is
// no longer read and stays as it is.
const ringPath = "workload/signing-keys-rs256.json";

const locations = ["app-secrets/", "app-keys/", ringPath] as const;

const position = z.strictObject({
  location: z
    .number()
    .int()
    .min(0)
    .max(locations.length - 1),
  cursor: z.string().min(1).optional(),
});

type Position = z.infer<typeof position>;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const encodePosition = (value: Position) => base64url.encode(JSON.stringify(value));

const decodePosition = (value: string) =>
  position.parse(JSON.parse(decoder.decode(base64url.decode(value))));

const snapshotPath = /^app-secrets\/[^/]+\/\d+\.json$/;

const appKeyPath = /^app-keys\/([^/]+)\/[^/]+\.json$/;

// Snapshots written before fingerprints were removed still carry one; the rewrite drops it.
const snapshot = z.object({ ciphertext: z.string() });

type Environment = Pick<ParentEnvironment, "WIDEFLEET_PACKAGES" | "WIDEFLEET_SECRETS_KEYS">;

/** The stored body sealed under the active key version, or `null` when it already is. */
const resealed = async (environment: Environment, path: string, body: string) => {
  if (path === ringPath) {
    const plaintext = await open(environment, "workload-keys", path, body);

    return sealedUnderActiveVersion(environment, "workload-keys", body)
      ? null
      : seal(environment, "workload-keys", path, plaintext);
  }

  if (snapshotPath.test(path)) {
    const { ciphertext } = snapshot.parse(JSON.parse(body));
    const plaintext = await open(environment, "app-secrets", path, ciphertext);

    return sealedUnderActiveVersion(environment, "app-secrets", ciphertext)
      ? null
      : JSON.stringify({ ciphertext: await seal(environment, "app-secrets", path, plaintext) });
  }

  const appId = appKeyPath.exec(path)?.[1];

  if (!appId) throw new Error("Unrecognized runtime storage object");

  const record = parseAppKey(body);
  const key = await openAppKey(environment, appId, path, record);

  return "ciphertext" in record &&
    sealedUnderActiveVersion(environment, "app-keys", record.ciphertext)
    ? null
    : sealAppKey(environment, path, key);
};

type Outcome = "current" | "rewritten" | "unreadable" | "conflicts" | "deleted";

const rewrite = async (environment: Environment, path: string): Promise<Outcome> => {
  const object = await environment.WIDEFLEET_PACKAGES.get(path);

  // An object deleted meanwhile stays deleted.
  if (!object) return "deleted";
  let next;

  try {
    next = await resealed(environment, path, await object.text());
  } catch {
    return "unreadable";
  }

  if (next === null) return "current";

  // A value written meanwhile is kept and counted; running the rewrite again reads it.
  const written = await environment.WIDEFLEET_PACKAGES.put(path, encoder.encode(next), {
    onlyIf: { etagMatches: object.etag },
  });

  return written ? "rewritten" : "conflicts";
};

export const rekeyRuntimeStorage = async (request: Request, environment: Environment) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const input = runtimeRekeyInput.parse(await request.json());
  const { location, cursor } = input.cursor ? decodePosition(input.cursor) : { location: 0 };
  const prefix = locations[location];

  if (!prefix) throw new Error("Unknown runtime storage location");

  const listed = await environment.WIDEFLEET_PACKAGES.list({
    prefix,
    limit: pageSize,
    ...(cursor && { cursor }),
  });

  const counts = { current: 0, rewritten: 0, unreadable: 0, conflicts: 0 };

  for (const object of listed.objects) {
    const outcome = await rewrite(environment, object.key);

    if (outcome !== "deleted") counts[outcome] += 1;
  }

  const next: Position | null = listed.truncated
    ? { location, cursor: listed.cursor }
    : location + 1 < locations.length
      ? { location: location + 1 }
      : null;

  return Response.json({
    result: runtimeRekeyPage.parse({ ...counts, cursor: next && encodePosition(next) }),
  });
};
