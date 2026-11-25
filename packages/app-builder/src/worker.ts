// The app builder Worker. POST /bundle builds an app project; POST /document
// documents the bundle's service entrypoints; POST /icons renders PNG app icons. Hosted installations deploy it
// twice, so each phase runs in its own isolate; self-hosted installations run
// one instance. Only the control plane reaches the builder: through service
// bindings, or on a private network without other workloads.
import {
  buildFailure,
  bundleRequest,
  documentRequest,
  iconsRequest,
} from "@platform/contracts/builds";
import { z } from "zod";
import { bundle } from "./bundle.ts";
import { BuildError } from "./configuration.ts";
import { document } from "./document.ts";
import { renderIcons } from "./icons.ts";

interface Environment {
  /** npm registry for dependencies, such as a company mirror. */
  NPM_REGISTRY?: string;
}

const failure = (status: number, message: string) =>
  Response.json(buildFailure.parse({ message }), { status });

export default {
  async fetch(request, environment) {
    const { pathname } = new URL(request.url);

    if (request.method !== "POST" || !["/bundle", "/document", "/icons"].includes(pathname))
      return failure(404, "Not found");

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

      if (pathname === "/icons") return Response.json(renderIcons(iconsRequest.parse(body).svg));

      return Response.json(await document(documentRequest.parse(body), registry));
    } catch (error) {
      if (error instanceof BuildError) return failure(422, error.message);

      if (error instanceof z.ZodError) return failure(400, z.prettifyError(error));

      throw error;
    }
  },
} satisfies ExportedHandler<Environment>;
