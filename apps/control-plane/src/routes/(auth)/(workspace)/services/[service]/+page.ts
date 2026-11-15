import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => ({ service: params.service });
