import {
  userConnectionInvocation,
  userConnectionStatus,
  userConnectionLaunch,
} from "@platform/contracts";
import { sessionVersion } from "@platform/auth-proxy/configuration";
import { readAuthConfiguration } from "@platform/auth-proxy/worker";
import { z } from "zod";
import { requireOrganizationAvailability } from "./availability.ts";
import { serviceTarget } from "./service-target.ts";
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
  const parsed = userConnectionInvocation.safeParse(await request.json());

  if (!parsed.success) return new Response(null, { status: 400 });
  const input = parsed.data;

  if (input.identityExpiresAt <= Date.now()) return new Response(null, { status: 401 });

  try {
    await requireOrganizationAvailability(environment, input.organizationId);
    const configuration = await readAuthConfiguration(environment, input.organizationId);

    if (
      !configuration ||
      (await sessionVersion(configuration.configuration)) !== input.identityVersion
    )
      return new Response(null, { status: 409 });

    const app = await serviceTarget(
      environment,
      input.organizationId,
      input.identity,
      input.hostname,
      "UserConnection",
    );

    if (!app || app.appId !== input.appId) return new Response(null, { status: 404 });
    const { issuer, subject, name } = input.identity;
    const caller = { issuer, subject, name };

    const proof = await signAppCaller(
      environment.WIDEFLEET_CONTROL_TOKEN,
      app.appId,
      input.organizationId,
      caller,
      Math.min(input.identityExpiresAt, Date.now() + 300_000),
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
