import { toSvelteKitHandler } from "better-auth/svelte-kit";
import { getRuntime } from "#server/runtime";
import type { RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async (event) =>
  toSvelteKitHandler((await getRuntime()).auth)(event);

export const POST = GET;
