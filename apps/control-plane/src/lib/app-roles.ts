import { createAccessControl } from "better-auth/plugins/access";
import { appAction, appRole } from "@platform/contracts";
import type { z } from "zod";

const access = createAccessControl({ app: appAction.options });

const developer = ["use", "read", "logs", "deploy", "rollback", "migrate"] as const;

const admin = [...developer, "roles", "network", "catalog", "delete"] as const;

export const appRoles = {
  user: access.newRole({ app: ["use"] }),
  developer: access.newRole({ app: developer }),
  admin: access.newRole({ app: admin }),
  owner: access.newRole({ app: [...admin, "transfer"] }),
};

export const rolesForAction = (action: z.infer<typeof appAction>) =>
  appRole.options.filter((role) => appRoles[role].authorize({ app: [action] }).success);
