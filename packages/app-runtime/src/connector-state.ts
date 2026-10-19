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
}

// These methods are supplied by the generated wrapper, never by connector code.
declare class LoadedConnectorFacet extends DurableObject {
  WIDEFLEET_DRAIN(): Promise<void>;
}

export class ConnectorSupervisor extends DurableObject<ParentEnvironment> {
  #pending = Promise.resolve();
  #current: { identity: StateVersion; facet: Fetcher<LoadedConnectorFacet> } | undefined;
  #calls = new Set<Promise<ConnectorValue | void>>();
  #track<T extends ConnectorValue | void>(result: Promise<T>) {
    this.#calls.add(result);
    void result.then(
      () => {
        this.#calls.delete(result);
      },
      () => {
        this.#calls.delete(result);
      },
    );

    return result;
  }
  #dispatch<T extends ConnectorValue | void>(
    identity: StateVersion,
    operation: (facet: Fetcher<LoadedConnectorFacet>) => Promise<T>,
  ) {
    // The draining generation must remain callable: its requests and waitUntil
    // work can await another call to this object while a replacement is queued.
    if (this.#current && JSON.stringify(this.#current.identity) === JSON.stringify(identity))
      return this.#track(operation(this.#current.facet));

    // Serialize generation changes, without queuing the draining generation's
    // nested calls behind the change that is waiting for them.
    const selected = this.#pending.then(async () => {
      const facet = await this.#facet(identity);
      const result = this.#track(operation(facet));

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
      !snapshot.release.metadata.durable_objects.some(
        (binding) => binding.class_name === identity.className,
      )
    )
      throw new Error("Connector Durable Object class is not declared");
    const worker = loadConnectorWorker(snapshot, this.env, this.ctx);

    const facetClass = worker.getDurableObjectClass<LoadedConnectorFacet>(identity.className);

    if (this.#current && this.#current.identity.version !== identity.version) {
      do {
        await Promise.allSettled(this.#calls);
        await this.#current.facet.WIDEFLEET_DRAIN();
        // Nested calls may have joined while the previous batch was draining.
      } while (this.#calls.size);

      this.#current = undefined;
      this.ctx.facets.abort("state", new Error("Connector version changed"));
    }

    await this.ctx.storage.put("identity", identity);

    const facet = this.ctx.facets.get("state", () => ({ class: facetClass }));
    this.#current = { identity, facet };

    return facet;
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
}
