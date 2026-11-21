import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

// The catalog of published apps is the home page. Links from before the move keep working.
export const load: PageServerLoad = () => {
  redirect(308, "/");
};
