// A running server build deploys with its own token, which the app CI adds to
// the build's requests to the control plane. It acts for whoever started the
// build, as they signed in and with their scopes, only on the build's app, and
// only while the build runs and before its deadline.
//
// The token names its build and is sealed with the installation's keyring, so
// it is not stored. Every run of a build gets a new one, and all of them stay
// valid as long as the build, so a run that joins another never ends its token.
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./database.ts";
import { deploymentActor } from "./deployment-execution.ts";
import { appBuilds } from "./schema.ts";
import type { SecretEncryption } from "./secret-encryption.ts";
import type { SignIn } from "./sso-policy.ts";

const prefix = "wfb_";

const context = (buildId: string) => ({ kind: "build-token", buildId }) as const;

export const createBuildToken = async (encryption: SecretEncryption, buildId: string) =>
  `${prefix}${buildId}.${await encryption.encrypt(context(buildId), buildId)}`;

export const isBuildToken = (token: string) => token.startsWith(prefix);

/** The build a token was issued for, or `null` when the installation did not issue it. */
const tokenBuild = async (encryption: SecretEncryption, token: string) => {
  const separator = token.indexOf(".");
  const buildId = z.uuid().safeParse(token.slice(prefix.length, separator));

  if (separator < 0 || !buildId.success) return null;

  const opened = await encryption
    .decrypt(context(buildId.data), token.slice(separator + 1))
    .catch(() => null);

  return opened === buildId.data ? buildId.data : null;
};

/** The sign-in a running build acts with, and its app, by its token. */
export const buildSignIn = async (
  database: Database,
  encryption: SecretEncryption,
  token: string,
) => {
  const buildId = await tokenBuild(encryption, token);

  if (!buildId) return null;

  const [record] = await database
    .select({
      appId: appBuilds.appId,
      actor: appBuilds.actor,
      identityOrganizationId: appBuilds.identityOrganizationId,
      recovery: appBuilds.recovery,
      reads: appBuilds.reads,
    })
    .from(appBuilds)
    .where(
      and(
        eq(appBuilds.id, buildId),
        eq(appBuilds.status, "running"),
        // The deadline is in database time.
        gt(appBuilds.deadline, sql`now()`),
      ),
    );

  if (!record) return null;

  const signIn: SignIn = {
    userId: deploymentActor.parse(record.actor).id,
    identityOrganizationId: record.identityOrganizationId,
    recovery: record.recovery,
  };

  return { signIn, appId: record.appId, reads: record.reads };
};
