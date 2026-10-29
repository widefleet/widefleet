import { requireOrganizationAvailability } from "./availability.ts";
import { executionOptions } from "./execution-limits.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { publishedCapability } from "@platform/contracts";
import type { z } from "zod";
import { readApp } from "./catalog.ts";
import { appWorker } from "./worker.ts";
import { invokeApp, type AppValue } from "./app-rpc.ts";
import type { ParentEnvironment } from "./types.ts";
import { signAppCaller, verifyAppCaller } from "./app-caller.ts";

// Props are supplied only by the trusted loader, never by calling app code.
export class AppService extends WorkerEntrypoint<
  ParentEnvironment,
  z.infer<typeof publishedCapability> & { sourceAppId: string }
> {
  async #target(proof?: string) {
    const { app: appId, hostname, organizationId, entrypoint, sourceAppId } = this.ctx.props;

    const assertion =
      proof === undefined
        ? null
        : await verifyAppCaller(
            this.env.WIDEFLEET_CONTROL_TOKEN,
            sourceAppId,
            organizationId,
            proof,
          );

    await requireOrganizationAvailability(this.env, organizationId);
    const app = await readApp(this.env, `hosts/${hostname}.json`);

    if (!app || app.appId !== appId || app.organizationId !== organizationId)
      throw new Error("App service is not available");

    if (!app.metadata.entrypoints?.includes(entrypoint))
      throw new Error("App service entrypoint is not available");

    const worker = await appWorker(app, this.env, this.ctx);

    return worker.getEntrypoint(entrypoint === "default" ? undefined : entrypoint, {
      ...executionOptions(this.env.WIDEFLEET_EXECUTION_LIMITS, "service"),
      props: {
        caller: assertion?.caller ?? null,
        // Each hop has a new audience, but never extends the original login delegation.
        appCaller: assertion
          ? await signAppCaller(
              this.env.WIDEFLEET_CONTROL_TOKEN,
              appId,
              organizationId,
              assertion.caller,
              assertion.expiresAt,
            )
          : undefined,
      },
    });
  }

  async invoke(method: string, args: AppValue[], proof?: string) {
    return invokeApp(await this.#target(proof), method, args);
  }

  override async fetch(request: Request) {
    const proof = request.headers.get("x-widefleet-app-caller") ?? undefined;
    const headers = new Headers(request.headers);
    headers.delete("x-widefleet-app-caller");

    // HTTP caller headers from a consumer are not an authentication mechanism.
    // Services read the verified principal from ctx.props.caller, just like RPC.
    for (const name of request.headers.keys())
      if (name.startsWith("x-auth-request-")) headers.delete(name);

    return (await this.#target(proof)).fetch(new Request(request, { headers }), {
      signal: request.signal,
    });
  }
}
