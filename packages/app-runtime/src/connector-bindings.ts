import { env } from "cloudflare:workers";
import { config } from "./config.ts";
import { connectorProxy } from "./connector-rpc.ts";
import type { ConnectorGateway } from "./connector-catalog.ts";
import type { ConnectorState } from "./connector-state.ts";
import { z } from "zod";

const service = <T extends ConnectorGateway | ConnectorState>(name: string) => {
  // SAFETY: Only the trusted loader supplies the facade's scoped service bindings.
  const binding = (env as Record<string, T>)[name];

  if (!binding) throw new Error("Connector binding is not initialized");

  return binding;
};

const install = (name: string, value: ReturnType<typeof connectorProxy> | ObjectNamespace) => {
  Object.defineProperty(env, name, { value, enumerable: true, writable: true, configurable: true });
};

for (const name of config.capabilities ?? [])
  install(
    name,
    connectorProxy(
      (method, args) =>
        service<ConnectorGateway>(`WIDEFLEET_CONNECTOR_${name}`).invoke(method, args),
      (request) => service<ConnectorGateway>(`WIDEFLEET_CONNECTOR_${name}`).fetch(request),
    ),
  );

class ObjectId {
  constructor(
    readonly value: string,
    readonly name?: string,
  ) {}
  toString() {
    return this.value;
  }
  equals(other: ObjectId) {
    return other.value === this.value;
  }
}

class ObjectNamespace {
  constructor(
    readonly binding: string,
    readonly scope: string,
  ) {}
  idFromName(name: string) {
    return new ObjectId(JSON.stringify([this.scope, "name", name]), name);
  }
  newUniqueId() {
    return new ObjectId(JSON.stringify([this.scope, "unique", crypto.randomUUID()]));
  }
  idFromString(value: string) {
    const identity = z
      .tuple([z.string(), z.enum(["name", "unique"]), z.string()])
      .parse(JSON.parse(value));

    if (identity[0] !== this.scope) throw new Error("Invalid connector object ID");

    return new ObjectId(JSON.stringify(identity), identity[1] === "name" ? identity[2] : undefined);
  }
  getByName(name: string) {
    return this.get(this.idFromName(name));
  }
  get(id: ObjectId) {
    const parsed = this.idFromString(id.toString());
    const target = () => service<ConnectorState>(`WIDEFLEET_STATE_${this.binding}`);

    return connectorProxy(
      (method, args) => target().invoke(parsed.value, method, args),
      (request) => {
        const headers = new Headers(request.headers);
        headers.set("x-widefleet-object-id", encodeURIComponent(parsed.value));

        return target().fetch(new Request(request, { headers }));
      },
      { id: parsed, name: parsed.name },
    );
  }
}

for (const binding of config.objects ?? [])
  install(binding.name, new ObjectNamespace(binding.name, binding.scope));
