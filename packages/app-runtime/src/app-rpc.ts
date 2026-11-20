import { z } from "zod";
import { appRpcMethod, inputAnswer, type InputAnswer } from "@platform/contracts";

// The common RPC contract is deliberately value based. celld does not transfer
// callbacks, RPC targets or streams across isolates.
export type AppValue = string | number | boolean | bigint | object | null | undefined;

export const appMethod = (method: string) => {
  if (!appRpcMethod.safeParse(method).success)
    throw new Error("App RPC method is reserved or invalid");

  return method;
};

export const invokeApp = (stub: Fetcher, method: string, args: AppValue[]) => {
  // SAFETY: Lookup stays on the native RPC stub, which enforces prototype-method
  // visibility and binds the receiver. Instance fields are never read locally.
  const callable = (stub as Fetcher & Record<string, (...input: AppValue[]) => Promise<AppValue>>)[
    appMethod(method)
  ];

  if (!callable) throw new Error("App method is unavailable");

  return callable(...args);
};

// Resolve a property to an RPC method, or undefined for properties that are not methods.
const rpcMethod = (
  property: string | symbol,
  invoke: (method: string, args: AppValue[]) => Promise<AppValue>,
) => {
  if (property === "then" || property === Symbol.toStringTag || property === Symbol.dispose)
    return undefined;
  const name = z.string().safeParse(property);

  if (!name.success) return undefined;
  const method = appMethod(name.data);

  return (...args: AppValue[]) => invoke(method, args);
};

export const appProxy = (
  invoke: (method: string, args: AppValue[], answer?: InputAnswer) => Promise<AppValue>,
  fetch: (request: Request) => Promise<Response>,
  properties: { id?: object; name?: string | undefined } = {},
) =>
  new Proxy(
    {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(new Request(input, init)),
      // Retry a call that asked for input; the answers reach the provider as ctx.props.input.
      withInput: (answer: InputAnswer) => {
        // App code supplies the answer; reject malformed input before calling.
        const parsed = inputAnswer.parse(answer);

        return new Proxy(
          {},
          {
            get: (_target, property) =>
              rpcMethod(property, (method, args) => invoke(method, args, parsed)),
          },
        );
      },
      ...properties,
    },
    {
      get(target, property) {
        if (property === "fetch") return target.fetch;

        if (property === "withInput") return target.withInput;

        if (property === "id" && Object.hasOwn(properties, "id")) return target.id;

        if (property === "name" && Object.hasOwn(properties, "name")) return target.name;

        return rpcMethod(property, invoke);
      },
    },
  );
