import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { z } from "zod";

export const installationOrganizationId = "widefleet";

export const organizationRole = z.enum(["owner", "admin", "member"]);

export const organizationAccess = createAccessControl({
  ...defaultStatements,
  app: ["create"],
  agent: ["manage"],
});

export const organizationRoles = {
  owner: organizationAccess.newRole({ member: ["update"], app: ["create"], agent: ["manage"] }),
  admin: organizationAccess.newRole({ member: ["update"], app: ["create"], agent: ["manage"] }),
  member: organizationAccess.newRole({ app: ["create"] }),
};
