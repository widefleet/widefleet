// A running server build deploys with its own token, which the app CI adds to
// the build's requests to the control plane. It acts for whoever started the
// build, as they signed in, only on the build's app, and expires with the run.
import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "./database.ts";
import { deploymentActor } from "./deployment-execution.ts";
import { appBuilds } from "./schema.ts";
import type { SignIn } from "./sso-policy.ts";

const prefix = "wfb_";

// Longer than one run of the build workflow, which issues a new token for each run.
const lifetime = 50 * 60 * 1000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export const createBuildToken = () => {
  const value = `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

  return { value, hash: hash(value), expiresAt: new Date(Date.now() + lifetime) };
};

export const isBuildToken = (token: string) => token.startsWith(prefix);

/** The sign-in a running build acts with, and its app, by its token. */
export const buildSignIn = async (database: Database, token: string) => {
  const [record] = await database
    .select({
      appId: appBuilds.appId,
      actor: appBuilds.actor,
      identityOrganizationId: appBuilds.identityOrganizationId,
      recovery: appBuilds.recovery,
    })
    .from(appBuilds)
    .where(
      and(
        eq(appBuilds.tokenHash, hash(token)),
        eq(appBuilds.status, "running"),
        gt(appBuilds.tokenExpiresAt, new Date()),
      ),
    );

  if (!record) return null;

  const signIn: SignIn = {
    userId: deploymentActor.parse(record.actor).id,
    identityOrganizationId: record.identityOrganizationId,
    recovery: record.recovery,
  };

  return { signIn, appId: record.appId };
};
