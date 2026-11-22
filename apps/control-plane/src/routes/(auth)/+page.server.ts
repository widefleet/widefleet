import { openOrganization } from "#server/page-auth";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = () => openOrganization("/");
