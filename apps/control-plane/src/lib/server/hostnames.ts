import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { apps, connectors, organizationRuntimes } from "./schema.ts";
import { InvalidOperation } from "./errors.ts";
import type { Transaction } from "./transactions.ts";

export const requireAvailableHostname = async (
  transaction: Transaction,
  hostname: string,
  domain: string,
  connector?: { organizationId: string; name: string },
) => {
  if (!z.hostname().safeParse(hostname).success || !URL.canParse(`https://${hostname}`))
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message: "The hostname is invalid or exceeds DNS length limits",
    });

  if (hostname === `auth.${domain}`)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "The auth hostname is reserved for SSO",
    });

  // The organization lock alone cannot serialize equal hostnames in different organizations.
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["hostname", hostname])}, 0))`,
  );

  const [app] = await transaction
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.hostname, hostname), isNull(apps.removedAt)))
    .limit(1);

  const [existing] = await transaction
    .select({ name: connectors.name })
    .from(connectors)
    .innerJoin(
      organizationRuntimes,
      eq(connectors.organizationId, organizationRuntimes.organizationId),
    )
    .where(
      and(
        sql`${connectors.name} || COALESCE('-' || ${organizationRuntimes.appHostnameSuffix}, '') || '.' || ${domain} = ${hostname}`,
        connector
          ? sql`NOT (${connectors.organizationId} = ${connector.organizationId} AND ${connectors.name} = ${connector.name})`
          : undefined,
      ),
    )
    .limit(1);

  if (app || existing)
    throw new InvalidOperation({
      code: "CONFLICT",
      message: "This hostname is already used by an app or connector",
    });
};
