import {
  userConnectionInvocation,
  userConnectionStatus,
  userConnectionLaunch,
} from "@platform/contracts";
import { issuer as providerIssuer } from "@platform/auth-proxy/identity";
import { readAuthConfiguration } from "@platform/auth-proxy/worker";
import { z } from "zod";
import { requireOrganizationAvailability } from "./availability.ts";
import { appTarget } from "./service-target.ts";
import { signAppCaller } from "./app-caller.ts";
import { appWorker } from "./worker.ts";
import { invokeApp } from "./app-rpc.ts";
import { executionOptions } from "./execution-limits.ts";
import type { ParentEnvironment } from "./types.ts";

export const manageUserConnection = async (
  request: Request,
  environment: ParentEnvironment,
  context: ExecutionContext,
) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const parsed = userConnectionInvocation.safeParse(await request.json().catch(() => null));

  if (!parsed.success) return new Response(null, { status: 400 });
  const input = parsed.data;

  try {
    await requireOrganizationAvailability(environment, input.organizationId);
    const configuration = await readAuthConfiguration(environment, input.organizationId);

    // The identity must come from the provider app sign-in currently uses.
    if (
      !configuration ||
      providerIssuer(configuration.configuration.provider) !== input.identity.issuer
    )
      return new Response(null, { status: 409 });

    // A member manages only their own account, so the app's access groups do
    // not apply here; using the app still requires them.
    const target = await appTarget(
      environment,
      input.organizationId,
      input.hostname,
      "UserConnection",
    );

    if (!target || target.app.appId !== input.appId) return new Response(null, { status: 404 });
    const app = target.app;
    const caller = input.identity;

    const proof = await signAppCaller(
      environment.WIDEFLEET_CONTROL_TOKEN,
      app.appId,
      input.organizationId,
      caller,
    );

    const worker = await appWorker(app, environment, context);

    const stub = worker.getEntrypoint("UserConnection", {
      ...executionOptions(environment.WIDEFLEET_EXECUTION_LIMITS, "service"),
      props: { caller, appCaller: proof },
    });

    const operation = input.operation;

    const result = await invokeApp(
      stub,
      operation.action,
      operation.action === "prepare" ? [{ completionUrl: operation.completionUrl }] : [],
    );

    if (operation.action === "status") return Response.json(userConnectionStatus.parse(result));

    if (operation.action === "disconnect")
      return Response.json(z.strictObject({ disconnected: z.literal(true) }).parse(result));
    const launch = userConnectionLaunch.parse(result);
    const destination = new URL(launch.url);

    if (
      destination.origin !== new URL(app.origin ?? `https://${app.hostname}`).origin ||
      destination.username ||
      destination.password ||
      destination.hash ||
      Date.parse(launch.expiresAt) <= Date.now() ||
      Date.parse(launch.expiresAt) > Date.now() + 300_000
    )
      throw new Error("The connector returned an invalid launch URL");

    return Response.json(launch);
  } catch {
    // Connector errors can contain provider data or credentials. Do not relay them.
    return Response.json({ error: "The connection is temporarily unavailable" }, { status: 503 });
  }
};
