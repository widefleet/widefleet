import { getRequestEvent } from "$app/server";

export type { Runtime } from "./runtime-services.ts";

export const getRuntime = () => getRequestEvent().locals.runtime();
