import { openOrganization } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

// Setup and sign-up end here before they know the organization's slug.
export const load: PageServerLoad = () => openOrganization("/welcome");
