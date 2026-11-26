import { WorkerEntrypoint } from "cloudflare:workers";
import { appSecretPreparation, appSecretName } from "@platform/contracts";
import { z } from "zod";
import { encryptSecrets, decryptSecrets } from "./secrets.ts";
import type { ParentEnvironment } from "./types.ts";

const secretKey = (identity: { appId: string; revision: number }) =>
  `app-secrets/${identity.appId}/${identity.revision}.json`;

const snapshot = z.object({ ciphertext: z.string() });

// The control plane reads a revision together with its values, so a retried deployment sends
// the same values again. A used revision with other values comes only from a control plane that
// lost its revision counter, for example after a database restore, and its values are current.
export const prepareAppSecrets = async (request: Request, environment: ParentEnvironment) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const input = appSecretPreparation.parse(await request.json());
  const path = secretKey(input);
  const ciphertext = await encryptSecrets(environment, "app-secrets", path, input.values);
  await environment.WIDEFLEET_PACKAGES.put(path, JSON.stringify({ ciphertext }));

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
      "app-secrets",
      path,
      snapshot.parse(await stored.json()).ciphertext,
    );

    if (!Object.hasOwn(values, name)) throw new Error("App secret is not configured");

    return values[name];
  }
}
