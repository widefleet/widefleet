import { WorkerEntrypoint } from "cloudflare:workers";
import { appSecretPreparation, appSecretName } from "@platform/contracts";
import { z } from "zod";
import { encryptSecrets, decryptSecrets } from "./secrets.ts";

const digest = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

import type { ParentEnvironment } from "./types.ts";

const secretKey = (identity: { appId: string; revision: number }) =>
  `app-secrets/${identity.appId}/${identity.revision}.json`;

const snapshot = z.object({ fingerprint: z.string(), ciphertext: z.string() });

export const prepareAppSecrets = async (request: Request, environment: ParentEnvironment) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const input = appSecretPreparation.parse(await request.json());
  const path = secretKey(input);

  const fingerprint = await digest(
    JSON.stringify(Object.entries(input.values).sort(([a], [b]) => a.localeCompare(b))),
  );

  const existing = await environment.WIDEFLEET_PACKAGES.get(path);

  if (existing) {
    if (snapshot.parse(await existing.json()).fingerprint !== fingerprint)
      throw new Error("App secret revision is immutable");
  } else {
    const ciphertext = await encryptSecrets(environment, path, input.values);

    if (
      !(await environment.WIDEFLEET_PACKAGES.put(
        path,
        JSON.stringify({ fingerprint, ciphertext }),
        { onlyIf: { etagDoesNotMatch: "*" } },
      ))
    )
      throw new Error("Concurrent app secret publication; retry this operation");
  }

  return Response.json({ result: { revision: input.revision } });
};

export class AppSecrets extends WorkerEntrypoint<
  ParentEnvironment,
  { appId: string; revision: number }
> {
  async get(name: string) {
    appSecretName.parse(name);
    const path = secretKey(this.ctx.props);
    const stored = await this.env.WIDEFLEET_PACKAGES.get(path);

    if (!stored) throw new Error("App secret is not configured");

    const values = await decryptSecrets(
      this.env,
      path,
      snapshot.parse(await stored.json()).ciphertext,
    );

    if (!Object.hasOwn(values, name)) throw new Error("App secret is not configured");

    return values[name];
  }
}
