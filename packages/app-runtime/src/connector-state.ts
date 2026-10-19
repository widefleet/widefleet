import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { connectorActivation } from "@platform/contracts";
import { connectorCatalog } from "./connector-catalog.ts";
import { connectorGeneration, readConnector } from "./connector-publication.ts";
import { loadConnectorWorker } from "./connector-code.ts";
import { invokeConnector, type ConnectorValue } from "./connector-rpc.ts";
import type { ParentEnvironment } from "./types.ts";

const stateIdentity = connectorActivation
  .omit({ version: true })
  .extend({ className: z.string(), objectId: z.string() });

const stateVersion = stateIdentity.merge(connectorGeneration);

type StateVersion = z.infer<typeof stateVersion>;

export class ConnectorState extends WorkerEntrypoint<
  ParentEnvironment,
  z.infer<typeof connectorActivation> & { className: string }
> {
  async #target(objectId: string) {
    const { fleetId, name, version, className } = this.ctx.props;
    const generation = await connectorCatalog(this.env, fleetId, name).generation(version);
    const identity = { ...generation, className, objectId };
    const namespace = this.env.WIDEFLEET_CONNECTOR_STATE;

    return {
      identity,
      stub: namespace.get(
        namespace.idFromName(JSON.stringify([fleetId, name, className, objectId])),
      ),
    };
  }
  async invoke(objectId: string, method: string, args: ConnectorValue[]) {
    const { stub, identity } = await this.#target(objectId);

    return stub.invoke(identity, method, args);
  }
  override async fetch(request: Request) {
    const objectId = request.headers.get("x-widefleet-object-id");

    if (!objectId) throw new Error("Connector object identity is missing");
    const { stub, identity } = await this.#target(decodeURIComponent(objectId));
    const headers = new Headers(request.headers);
    headers.delete("x-widefleet-object-id");
    headers.set("x-widefleet-state", encodeURIComponent(JSON.stringify(identity)));

    return stub.fetch(new Request(request, { headers }), { signal: request.signal });
  }
  async scheduleAlarm(objectId: string, operation: "get" | "set" | "delete", time?: number) {
    const { stub, identity } = await this.#target(objectId);

    return stub.schedule(identity, operation, time);
  }
}

// These methods are supplied by the generated wrapper, never by connector code.
declare class LoadedConnectorFacet extends DurableObject {
  WIDEFLEET_DRAIN(): Promise<void>;
  WIDEFLEET_ALARM(info?: AlarmInvocationInfo): Promise<void>;
}

export class ConnectorSupervisor extends DurableObject<ParentEnvironment> {
  #pending = Promise.resolve();
  #version: string | undefined;
  #running: Fetcher<LoadedConnectorFacet> | undefined;
  #calls = new Set<Promise<ConnectorValue | void>>();
  #dispatch<T extends ConnectorValue | void>(
    identity: StateVersion,
    operation: (facet: Fetcher<LoadedConnectorFacet>) => Promise<T>,
  ) {
    // Serialize generation selection, while allowing calls on the same facet to
    // interleave normally. A version switch waits for all earlier calls.
    const selected = this.#pending.then(async () => {
      const facet = await this.#facet(identity);
      const result = operation(facet);
      this.#calls.add(result);
      void result.then(
        () => {
          this.#calls.delete(result);
        },
        () => {
          this.#calls.delete(result);
        },
      );

      return { result };
    });

    this.#pending = selected.then(
      () => undefined,
      () => undefined,
    );

    return selected.then(({ result }) => result);
  }
  async #facet(identity: StateVersion) {
    const previous = stateVersion.optional().parse(await this.ctx.storage.get("identity"));

    if (
      previous &&
      JSON.stringify(stateIdentity.strip().parse(previous)) !==
        JSON.stringify(stateIdentity.strip().parse(identity))
    )
      throw new Error("Connector object identity mismatch");

    if (previous && previous.sequence > identity.sequence)
      throw new Error("Connector object version was superseded");
    const snapshot = await readConnector(this.env, identity);

    if (
      !snapshot.release.configuration.durable_objects.bindings.some(
        (binding) => binding.class_name === identity.className,
      )
    )
      throw new Error("Connector Durable Object class is not declared");
    const worker = loadConnectorWorker(snapshot, this.env, this.ctx);

    const facetClass = worker.getDurableObjectClass<LoadedConnectorFacet>(identity.className, {
      props: { objectId: identity.objectId },
    });

    if (this.#version && this.#version !== identity.version) {
      await Promise.allSettled(this.#calls);
      // waitUntil work belongs to the old facet too, even after its caller left.
      await this.#running?.WIDEFLEET_DRAIN();
      this.ctx.facets.abort("state", new Error("Connector version changed"));
    }

    this.#version = identity.version;
    await this.ctx.storage.put("identity", identity);

    this.#running = this.ctx.facets.get("state", () => ({ class: facetClass }));

    return this.#running;
  }
  invoke(identity: StateVersion, method: string, args: ConnectorValue[]) {
    return this.#dispatch(stateVersion.parse(identity), async (facet) =>
      invokeConnector(facet, method, args),
    );
  }
  override fetch(request: Request) {
    const identity = stateVersion.parse(
      JSON.parse(decodeURIComponent(request.headers.get("x-widefleet-state") ?? "null")),
    );

    const headers = new Headers(request.headers);
    headers.delete("x-widefleet-state");

    return this.#dispatch(identity, (facet) =>
      facet.fetch(new Request(request, { headers }), { signal: request.signal }),
    );
  }
  async schedule(identity: StateVersion, operation: "get" | "set" | "delete", time?: number) {
    const current = stateVersion.parse(await this.ctx.storage.get("identity"));

    if (JSON.stringify(current) !== JSON.stringify(stateVersion.parse(identity)))
      throw new Error("Connector alarm version was superseded");

    switch (operation) {
      case "get":
        return this.ctx.storage.getAlarm();
      case "set":
        await this.ctx.storage.setAlarm(z.number().finite().parse(time));

        return null;
      case "delete":
        await this.ctx.storage.deleteAlarm();

        return null;
    }
  }
  override async alarm(info?: AlarmInvocationInfo) {
    const previous = stateVersion.parse(await this.ctx.storage.get("identity"));
    const active = await connectorCatalog(this.env, previous.fleetId, previous.name).current();

    if (!active) throw new Error("Connector is not active");

    const invocation = info && {
      isRetry: info.isRetry,
      retryCount: info.retryCount,
      scheduledTime: info.scheduledTime,
    };

    return this.#dispatch({ ...previous, ...active }, (facet) => facet.WIDEFLEET_ALARM(invocation));
  }
}
