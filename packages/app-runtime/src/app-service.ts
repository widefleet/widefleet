import { requireOrganizationAvailability } from "./availability.ts";
import { executionOptions } from "./execution-limits.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { InputAnswer, publishedCapability } from "@platform/contracts";
import type { z } from "zod";
import { readApp } from "./catalog.ts";
import { appWorker } from "./worker.ts";
import { invokeApp, type AppValue } from "./app-rpc.ts";
import type { ParentEnvironment } from "./types.ts";
import { signAppCaller, verifyAppCaller } from "./app-caller.ts";
import { openInput, requestedInput, sealInput } from "./service-input.ts";

// Props are supplied only by the trusted loader, never by calling app code.
export class AppService extends WorkerEntrypoint<
  ParentEnvironment,
  z.infer<typeof publishedCapability> & { sourceAppId: string }
> {
  async #assertion(proof?: string) {
    const { organizationId, sourceAppId } = this.ctx.props;

    return proof === undefined
      ? null
      : verifyAppCaller(this.env.WIDEFLEET_CONTROL_TOKEN, sourceAppId, organizationId, proof);
  }

  async #target(
    assertion: Awaited<ReturnType<typeof verifyAppCaller>> | null,
    input?: Awaited<ReturnType<typeof openInput>>,
  ) {
    const { app: appId, hostname, organizationId, entrypoint } = this.ctx.props;

    await requireOrganizationAvailability(this.env, organizationId);
    const app = await readApp(this.env, `hosts/${hostname}.json`, { appId, organizationId });

    if (!app || app.appId !== appId || app.organizationId !== organizationId)
      throw new Error("App service is not available");

    if (!app.metadata.entrypoints?.includes(entrypoint))
      throw new Error("App service entrypoint is not available");

    const worker = await appWorker(app, this.env, this.ctx);

    const props = {
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
    };

    return worker.getEntrypoint(entrypoint === "default" ? undefined : entrypoint, {
      ...executionOptions(this.env.WIDEFLEET_EXECUTION_LIMITS, "service"),
      props: input ? { ...props, input } : props,
    });
  }

  // `answer` carries the calling app's responses when it retries with `withInput`.
  async invoke(method: string, args: AppValue[], proof?: string, answer?: InputAnswer) {
    const { app: appId, entrypoint, sourceAppId } = this.ctx.props;
    const assertion = await this.#assertion(proof);
    const secret = this.env.WIDEFLEET_CONTROL_TOKEN;

    // Answers belong to the calling app and its user, and to this exact call.
    const binding = JSON.stringify([
      "app",
      sourceAppId,
      assertion?.caller.issuer ?? null,
      assertion?.caller.subject ?? null,
    ]);

    const call = { appId, entrypoint, method, args };

    const input = answer === undefined ? undefined : await openInput(secret, binding, call, answer);

    const value = await invokeApp(await this.#target(assertion, input), method, args);
    const question = requestedInput(value);

    return question ? sealInput(secret, binding, call, question) : value;
  }

  override async fetch(request: Request) {
    const proof = request.headers.get("x-widefleet-app-caller") ?? undefined;
    const headers = new Headers(request.headers);
    headers.delete("x-widefleet-app-caller");

    // HTTP caller headers from a consumer are not an authentication mechanism.
    // Services read the verified principal from ctx.props.caller, just like RPC.
    for (const name of request.headers.keys())
      if (name.startsWith("x-auth-request-")) headers.delete(name);

    return (await this.#target(await this.#assertion(proof))).fetch(
      new Request(request, { headers }),
      {
        signal: request.signal,
      },
    );
  }
}
