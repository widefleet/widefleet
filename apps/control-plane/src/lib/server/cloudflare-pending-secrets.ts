import { eq, inArray, notExists } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.ts";
import { apps, cloudflareOperations, deployments } from "./schema.ts";

/** The R2 operations a command store needs; the artifacts bucket provides them. */
export type CommandStore = {
  list: (options: {
    prefix: string;
    cursor?: string;
  }) => Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
};

/** The deployment Workflow binding's instance lookup. */
export type DeploymentWorkflows = {
  get: (id: string) => Promise<{ status: () => Promise<{ status: string }> }>;
};

// Statuses of an instance that can still run its registration step.
const active = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

const command = z.looseObject({
  kind: z.literal("deploy"),
  secrets: z.record(z.string(), z.string()),
});

const commandFile = /^([0-9a-f-]{36})\.json$/;

const isActive = async (workflows: DeploymentWorkflows, id: string) => {
  try {
    return active.has((await (await workflows.get(id)).status()).status);
  } catch {
    // An unknown instance never registers its command.
    return false;
  }
};

/**
 * Finds the secrets of hosted deployments that their Workflow has not
 * registered yet. A template install's command carries encrypted secrets in R2
 * and in the Workflow's parameters until registration saves them on the app,
 * so an earlier key version stays needed until these are gone.
 */
export const readPendingDeploymentSecrets = async (
  database: Database,
  commands: CommandStore,
  workflows: DeploymentWorkflows | undefined,
) => {
  const ciphertexts: string[] = [];
  let waiting = 0;

  if (!workflows) return { deployments: waiting, ciphertexts };

  // Commands with secrets claim an app's first deployment, so only apps without
  // one can still receive them.
  const candidates = await database
    .select({ id: apps.id })
    .from(apps)
    .where(
      notExists(
        database
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.appId, apps.id)),
      ),
    );

  for (const { id: appId } of candidates) {
    const prefix = `apps/${appId}/commands/`;

    for (let cursor: string | undefined, more = true; more;) {
      const listed = await commands.list(cursor === undefined ? { prefix } : { prefix, cursor });

      const files = listed.objects.flatMap(({ key }) => {
        const id = commandFile.exec(key.slice(prefix.length))?.[1];

        return id ? [{ key, id }] : [];
      });

      const registered = new Set(
        files.length === 0
          ? []
          : (
              await database
                .select({ id: cloudflareOperations.id })
                .from(cloudflareOperations)
                .where(
                  inArray(
                    cloudflareOperations.id,
                    files.map(({ id }) => id),
                  ),
                )
            ).map(({ id }) => id),
      );

      for (const file of files) {
        if (registered.has(file.id) || !(await isActive(workflows, file.id))) continue;
        const object = await commands.get(file.key);

        if (!object) continue;
        let document: unknown;

        try {
          document = JSON.parse(await object.text());
        } catch {
          // A command that cannot be read may still carry secrets.
          waiting += 1;
          continue;
        }

        const parsed = command.safeParse(document);

        if (!parsed.success) continue;
        waiting += 1;
        ciphertexts.push(...Object.values(parsed.data.secrets));
      }

      more = listed.truncated;
      cursor = listed.cursor;
    }
  }

  return { deployments: waiting, ciphertexts };
};
