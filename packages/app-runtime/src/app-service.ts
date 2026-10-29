import { requireOrganizationAvailability } from "./availability.ts";
import { executionOptions } from "./execution-limits.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { publishedCapability } from "@platform/contracts";
import type { z } from "zod";
import { readApp } from "./catalog.ts";
import { workerCode } from "./worker.ts";
import { invokeApp, type AppValue } from "./app-rpc.ts";
import type { ParentEnvironment } from "./types.ts";

// Props are supplied only by the trusted loader, never by calling app code.
export class AppService extends WorkerEntrypoint<
  ParentEnvironment,
  z.infer<typeof publishedCapability>
> {
  async #target() {
    const { app: appId, hostname, organizationId, entrypoint } = this.ctx.props;

    await requireOrganizationAvailability(this.env, organizationId);
    const app = await readApp(this.env, `hosts/${hostname}.json`);

    if (!app || app.appId !== appId || app.organizationId !== organizationId)
      throw new Error("App service is not available");

    if (!app.metadata.entrypoints?.includes(entrypoint))
      throw new Error("App service entrypoint is not available");

    const worker = this.env.WIDEFLEET_LOADER.get(app.version, () =>
      workerCode(app, this.env, this.ctx),
    );

    return worker.getEntrypoint(
      entrypoint === "default" ? undefined : entrypoint,
      executionOptions(this.env.WIDEFLEET_EXECUTION_LIMITS, "service"),
    );
  }

  async invoke(method: string, args: AppValue[]) {
    return invokeApp(await this.#target(), method, args);
  }

  override async fetch(request: Request) {
    return (await this.#target()).fetch(request, { signal: request.signal });
  }
}
