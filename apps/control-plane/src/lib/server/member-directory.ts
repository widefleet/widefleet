import { and, asc, eq, ilike, or } from "drizzle-orm";
import { installationOrganizationId } from "../organization.ts";
import { member, user } from "./auth-schema.ts";
import type { Database } from "./database.ts";
import type { Transaction } from "./transactions.ts";

export const findMembers = (database: Database | Transaction, search: string, offset = 0) => {
  const pattern = `%${search.replaceAll(/[%_\\]/g, "\\$&")}%`;

  return database
    .select({
      id: member.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, installationOrganizationId),
        or(ilike(user.name, pattern), ilike(user.email, pattern)),
      ),
    )
    .orderBy(asc(user.name), asc(user.id))
    .limit(51)
    .offset(offset);
};
