import { error } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";

// The request hook authorized the organization. An error from a load renders the error page.
export const load: LayoutServerLoad = ({ locals, params }) => {
  if (locals.workspace?.slug !== params.organization) error(404, "Organization not found.");
};
