import { defineParams } from "@sveltejs/kit/params";
import { organizationSlug } from "@platform/contracts";

export const params = defineParams({
  // Workspace pages start with the organization slug. Other paths fall through to a 404.
  organization: organizationSlug,
});
