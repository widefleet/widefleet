import type { RequestHandler } from "@sveltejs/kit";
import { createApi } from "#server/api";
import { getRuntime } from "#server/runtime";

export const GET: RequestHandler = async ({ request }) => {
  const handler = createApi(await getRuntime());

  return handler(request);
};

export const POST = GET;

export const PUT = GET;

export const PATCH = GET;

export const DELETE = GET;
