import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  connectorPreparation,
  connectorActivation,
  connectorManagement,
  publishedCapability,
} from "@platform/contracts";
import { z } from "zod";
import {
  connectorGeneration,
  connectorKey,
  connectorSnapshot,
  digest,
  encryptConnectorSecrets,
  readConnector,
} from "./connector-publication.ts";
import { loadConnectorWorker } from "./connector-code.ts";
import { invokeConnector, type ConnectorValue } from "./connector-rpc.ts";
import type { ParentEnvironment } from "./types.ts";

export const connectorCatalog = (environment: ParentEnvironment, fleetId: string, name: string) =>
  environment.WIDEFLEET_CONNECTORS.get(
    environment.WIDEFLEET_CONNECTORS.idFromName(JSON.stringify([fleetId, name])),
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
    const { fleetId, version, release, secrets, nativeBindings, telemetry } = prepared;
    const identity = { fleetId, version, name: release.name };

    const fingerprint = await digest(
      JSON.stringify({ release, nativeBindings, secrets, telemetry }),
    );

    const active = await this.current();

    if (active && (await readConnector(this.env, active)).fingerprint === fingerprint)
      return { fleetId: active.fleetId, name: active.name, version: active.version };

    const existing = await this.env.WIDEFLEET_PACKAGES.get(connectorKey(identity));
    let snapshot;

    if (existing) {
      snapshot = connectorSnapshot.parse(await existing.json());

      if (snapshot.fingerprint !== fingerprint) throw new Error("Connector version is immutable");
    } else {
      snapshot = connectorSnapshot.parse({
        fleetId,
        version,
        release,
        nativeBindings,
        telemetry,
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
      await worker.getEntrypoint<ConnectorReadiness>("WIDEFLEET_READY").ready();
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
  z.infer<typeof publishedCapability>
> {
  async #target() {
    const { fleetId, connector, entrypoint } = this.ctx.props;
    const active = await connectorCatalog(this.env, fleetId, connector).current();

    if (!active) throw new Error("Connector is not active");
    const snapshot = await readConnector(this.env, active);

    if (!snapshot.release.entrypoints.includes(entrypoint))
      throw new Error("Connector entrypoint is not available");
    const worker = loadConnectorWorker(snapshot, this.env, this.ctx);

    return worker.getEntrypoint(entrypoint === "default" ? undefined : entrypoint);
  }
  async invoke(method: string, args: ConnectorValue[]) {
    return invokeConnector(await this.#target(), method, args);
  }
  override async fetch(request: Request) {
    return (await this.#target()).fetch(request, { signal: request.signal });
  }
}

export const manageConnector = async (request: Request, environment: ParentEnvironment) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  try {
    const input = connectorManagement.parse(await request.json());
    let result;

    if (input.action === "prepare") {
      const { action: _action, ...preparation } = input;
      result = await connectorCatalog(environment, input.fleetId, input.release.name).prepare(
        preparation,
      );
    } else {
      const { action: _action, ...activation } = input;
      result = await connectorCatalog(environment, input.fleetId, input.name).activate(activation);
    }

    return Response.json({
      result: { fleetId: result.fleetId, name: result.name, version: result.version },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Connector operation failed" },
      { status: 409 },
    );
  }
};
