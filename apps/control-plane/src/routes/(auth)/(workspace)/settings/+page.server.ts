import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

// Settings has no overview; earlier links and sign-in callbacks keep their query on the first section.
export const load: PageServerLoad = ({ url }) => {
  redirect(308, `/settings/company-sign-in${url.search}`);
};
