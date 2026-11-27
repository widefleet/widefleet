// A running server build deploys with its own token, which the app CI adds to
// the build's requests to the control plane. It acts for whoever started the
// build and is valid only while the build runs.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "./database.ts";
import { deploymentActor } from "./deployment-execution.ts";
import { appBuilds } from "./schema.ts";

const prefix = "wfb_";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export const createBuildToken = () => {
  const value = `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

  return { value, hash: hash(value) };
};

export const isBuildToken = (token: string) => token.startsWith(prefix);

/** The person a running build acts for, by its token. */
export const buildActor = async (database: Database, token: string) => {
  const [record] = await database
    .select({ actor: appBuilds.actor })
    .from(appBuilds)
    .where(and(eq(appBuilds.tokenHash, hash(token)), eq(appBuilds.status, "running")));

  return record ? deploymentActor.parse(record.actor) : null;
};
