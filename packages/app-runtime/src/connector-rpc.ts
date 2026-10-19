import { z } from "zod";

// The common RPC contract is deliberately value based. celld does not transfer
// callbacks, RPC targets or streams across isolates.
export type ConnectorValue = string | number | boolean | bigint | object | null | undefined;

const reserved = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "then",
  "catch",
  "finally",
  "fetch",
  "connect",
  "scheduled",
  "queue",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

export const connectorMethod = (method: string) => {
  if (
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method) ||
    reserved.has(method) ||
    method.startsWith("WIDEFLEET_")
  )
    throw new Error("Connector RPC method is reserved or invalid");

  return method;
};

export const invokeConnector = (stub: Fetcher, method: string, args: ConnectorValue[]) => {
  // SAFETY: Lookup stays on the native RPC stub, which enforces prototype-method
  // visibility and binds the receiver. Instance fields are never read locally.
  const callable = (
    stub as Fetcher & Record<string, (...input: ConnectorValue[]) => Promise<ConnectorValue>>
  )[connectorMethod(method)];

  if (!callable) throw new Error("Connector method is unavailable");

  return callable(...args);
};

export const connectorProxy = (
  invoke: (method: string, args: ConnectorValue[]) => Promise<ConnectorValue>,
  fetch: (request: Request) => Promise<Response>,
  properties: { id?: object; name?: string | undefined } = {},
) =>
  new Proxy(
    {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(new Request(input, init)),
      ...properties,
    },
    {
      get(target, property) {
        if (property === "fetch") return target.fetch;

        if (property === "id" && Object.hasOwn(properties, "id")) return target.id;

        if (property === "name" && Object.hasOwn(properties, "name")) return target.name;

        if (property === "then" || property === Symbol.toStringTag || property === Symbol.dispose)
          return undefined;
        const name = z.string().safeParse(property);

        if (!name.success) return undefined;
        const method = connectorMethod(name.data);

        return (...args: ConnectorValue[]) => invoke(method, args);
      },
    },
  );
