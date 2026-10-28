import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  connectorPreparation,
  connectorActivation,
  connectorManagement,
  publishedCapability,
  connectorCaller,
  connectorBrowserUrl,
} from "@platform/contracts";
import { z } from "zod";
import {
  connectorGeneration,
  connectorKey,
  connectorSnapshot,
  digest,
  encryptConnectorSecrets,
  readConnector,
  connectorBrowserKey,
} from "./connector-publication.ts";
import { loadConnectorWorker } from "./connector-code.ts";
import { invokeConnector, type ConnectorValue } from "./connector-rpc.ts";
import type { ParentEnvironment } from "./types.ts";
import { requireOrganizationAvailability } from "./availability.ts";
import { executionOptions } from "./execution-limits.ts";
import { verifyConnectorCaller } from "./connector-caller.ts";

export const connectorCatalog = (
  environment: ParentEnvironment,
  organizationId: string,
  name: string,
) =>
  environment.WIDEFLEET_CONNECTORS.get(
    environment.WIDEFLEET_CONNECTORS.idFromName(JSON.stringify([organizationId, name])),
  );

export class ConnectorCatalog extends DurableObject<ParentEnvironment> {
  async current() {
    return connectorGeneration.nullable().parse((await this.ctx.storage.get("active")) ?? null);
  }
  async generation(version: string) {
    return connectorGeneration.parse(await this.ctx.storage.get(`generation/${version}`));
  }
  async prepare(input: z.infer<typeof connectorPreparation>) {
    const prepared = connectorPreparation.parse(input);

    const { organizationId, version, release, secrets, nativeBindings, telemetry, browserOrigin } =
      prepared;

    if (release.metadata.browser_entrypoints?.length && !browserOrigin)
      throw new Error("Connector browser origin is missing; update the deployment agent");
    const identity = { organizationId, version, name: release.name };

    // Omit absent origins from the hash so retries still match pre-upgrade snapshots.
    const fingerprint = await digest(
      JSON.stringify({
        release,
        nativeBindings,
        secrets,
        telemetry,
        browserOrigin: browserOrigin ?? undefined,
      }),
    );

    const active = await this.current();

    if (active && (await readConnector(this.env, active)).fingerprint === fingerprint)
      return { organizationId: active.organizationId, name: active.name, version: active.version };

    const existing = await this.env.WIDEFLEET_PACKAGES.get(connectorKey(identity));
    let snapshot;

    if (existing) {
      snapshot = connectorSnapshot.parse(await existing.json());

      if (snapshot.fingerprint !== fingerprint) throw new Error("Connector version is immutable");
    } else {
      snapshot = connectorSnapshot.parse({
        organizationId,
        version,
        release,
        nativeBindings,
        telemetry,
        browserOrigin,
        fingerprint,
        previous: active?.version ?? null,
        ciphertext: await encryptConnectorSecrets(this.env, identity, secrets),
      });

      const stored = await this.env.WIDEFLEET_PACKAGES.put(
        connectorKey(identity),
        JSON.stringify(snapshot),
        { onlyIf: { etagDoesNotMatch: "*" } },
      );

      if (!stored) throw new Error("Concurrent connector preparation; retry this operation");
    }

    const worker = loadConnectorWorker(snapshot, this.env, this.ctx);

    try {
      await worker
        .getEntrypoint<ConnectorReadiness>(
          "WIDEFLEET_READY",
          executionOptions(this.env.WIDEFLEET_EXECUTION_LIMITS, "readiness"),
        )
        .ready();
    } catch (error) {
      worker.dispose?.();
      throw error;
    }

    await this.ctx.storage.put(`prepared/${version}`, fingerprint);

    return identity;
  }
  async activate(input: z.infer<typeof connectorActivation>) {
    const identity = connectorActivation.parse(input);
    const snapshot = await readConnector(this.env, identity);

    if ((await this.ctx.storage.get(`prepared/${identity.version}`)) !== snapshot.fingerprint)
      throw new Error("Connector version has not passed readiness checks");

    // This index is only a routing hint. Each browser request checks the active
    // snapshot's origin and explicit browser entrypoints before executing code.
    if (snapshot.browserOrigin)
      await this.env.WIDEFLEET_PACKAGES.put(
        connectorBrowserKey(new URL(snapshot.browserOrigin).hostname),
        JSON.stringify({
          organizationId: identity.organizationId,
          name: identity.name,
          origin: snapshot.browserOrigin,
        }),
      );

    return this.ctx.storage.transaction(async (storage) => {
      const current = connectorGeneration.nullable().parse((await storage.get("active")) ?? null);

      if (current?.version === identity.version) return current;

      if ((current?.version ?? null) !== snapshot.previous)
        throw new Error("Connector activation was superseded");
      const next = { ...identity, sequence: (current?.sequence ?? 0) + 1 };
      await storage.put("active", next);
      await storage.put(`generation/${identity.version}`, next);

      return next;
    });
  }
}

// Only the generated bootstrap exports this entrypoint in the child isolate.
declare class ConnectorReadiness extends WorkerEntrypoint {
  ready(): Promise<boolean>;
}

export class ConnectorGateway extends WorkerEntrypoint<
  ParentEnvironment,
  z.infer<typeof publishedCapability> & {
    appId?: string;
    caller?: z.infer<typeof connectorCaller>;
    browser?: boolean;
  }
> {
  async #snapshot() {
    const { organizationId, connector, entrypoint } = this.ctx.props;
    await requireOrganizationAvailability(this.env, organizationId);
    const active = await connectorCatalog(this.env, organizationId, connector).current();

    if (!active) throw new Error("Connector is not active");
    const snapshot = await readConnector(this.env, active);

    if (
      this.ctx.props.browser &&
      !snapshot.release.metadata.browser_entrypoints?.includes(entrypoint)
    )
      return null;

    if (!snapshot.release.metadata.entrypoints.includes(entrypoint))
      throw new Error("Connector entrypoint is not available");

    return snapshot;
  }
  async #target(proof?: string, origin?: string) {
    const snapshot = await this.#snapshot();

    if (!snapshot || (this.ctx.props.browser && snapshot.browserOrigin !== origin)) return null;
    const { organizationId, entrypoint } = this.ctx.props;

    if (proof && !this.ctx.props.appId && !this.ctx.props.caller)
      throw new Error("Connector caller has no originating app");
    const worker = loadConnectorWorker(snapshot, this.env, this.ctx);

    const caller =
      this.ctx.props.caller ??
      (proof && this.ctx.props.appId
        ? await verifyConnectorCaller(
            this.env.WIDEFLEET_CONTROL_TOKEN,
            this.ctx.props.appId,
            organizationId,
            proof,
          )
        : null);

    return worker.getEntrypoint(entrypoint === "default" ? undefined : entrypoint, {
      ...executionOptions(this.env.WIDEFLEET_EXECUTION_LIMITS, "connector"),
      props: { caller },
    });
  }
  async invoke(method: string, args: ConnectorValue[], proof?: string) {
    const target = await this.#target(proof);

    if (!target) throw new Error("Connector entrypoint is unavailable");

    return invokeConnector(target, method, args);
  }
  async redirect(request: Request, binding: string) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    const snapshot = await this.#snapshot();

    if (!snapshot?.browserOrigin) return new Response(null, { status: 404 });
    const incoming = new URL(request.url);
    const prefix = `/_widefleet/connectors/${binding}/`;

    if (!incoming.pathname.startsWith(prefix)) return new Response(null, { status: 404 });
    const target = new URL(connectorBrowserUrl(snapshot.browserOrigin, this.ctx.props.entrypoint));
    target.pathname += incoming.pathname.slice(prefix.length);
    target.search = incoming.search;

    return new Response(null, {
      status: 302,
      headers: { location: target.href, "cache-control": "no-store" },
    });
  }
  override async fetch(request: Request) {
    const proof = request.headers.get("x-widefleet-connector-caller") ?? undefined;
    const target = await this.#target(proof, new URL(request.url).origin);

    if (!target) return new Response(null, { status: 404 });
    const headers = new Headers(request.headers);
    headers.delete("x-widefleet-connector-caller");

    return target.fetch(new Request(request, { headers, redirect: "manual" }), {
      signal: request.signal,
    });
  }
}

export const manageConnector = async (request: Request, environment: ParentEnvironment) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  try {
    const input = connectorManagement.parse(await request.json());
    let result;

    if (input.action === "prepare") {
      const { action: _action, ...preparation } = input;
      result = await connectorCatalog(
        environment,
        input.organizationId,
        input.release.name,
      ).prepare(preparation);
    } else {
      const { action: _action, ...activation } = input;
      result = await connectorCatalog(environment, input.organizationId, input.name).activate(
        activation,
      );
    }

    return Response.json({
      result: { organizationId: result.organizationId, name: result.name, version: result.version },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Connector operation failed" },
      { status: 409 },
    );
  }
};
