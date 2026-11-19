// The app builder Worker. POST /bundle builds an app project; POST /document
// documents the bundle's service entrypoints. Hosted installations deploy it
// twice, so each phase runs in its own isolate; self-hosted installations run
// one instance and authenticate requests with BUILDER_TOKEN.
import { buildFailure, bundleRequest, documentRequest } from "@platform/contracts/builds";
import { z } from "zod";
import { bundle } from "./bundle.ts";
import { BuildError } from "./configuration.ts";
import { document } from "./document.ts";

interface Environment {
  /** Required bearer token when the builder is reachable over HTTP. */
  BUILDER_TOKEN?: string;
  /** npm registry for dependencies, such as a company mirror. */
  NPM_REGISTRY?: string;
}

const failure = (status: number, message: string) =>
  Response.json(buildFailure.parse({ message }), { status });

const authorized = async (request: Request, token: string | undefined) => {
  if (!token) return true;

  const presented = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;

  const [left, right] = await Promise.all(
    [presented, expected].map(async (value) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );

  return left !== undefined && right !== undefined && crypto.subtle.timingSafeEqual(left, right);
};

export default {
  async fetch(request, environment) {
    const { pathname } = new URL(request.url);

    if (request.method !== "POST" || (pathname !== "/bundle" && pathname !== "/document"))
      return failure(404, "Not found");

    if (!(await authorized(request, environment.BUILDER_TOKEN)))
      return failure(401, "Unauthorized");

    const registry = environment.NPM_REGISTRY ?? "https://registry.npmjs.org";

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      return failure(400, "The request body is not valid JSON");
    }

    try {
      if (pathname === "/bundle")
        return Response.json(await bundle(bundleRequest.parse(body).files, registry));

      return Response.json(await document(documentRequest.parse(body), registry));
    } catch (error) {
      if (error instanceof BuildError) return failure(422, error.message);

      if (error instanceof z.ZodError) return failure(400, z.prettifyError(error));

      throw error;
    }
  },
} satisfies ExportedHandler<Environment>;
