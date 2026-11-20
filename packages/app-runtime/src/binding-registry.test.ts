import { describe, expect, it } from "vitest";
import { bindingRegistry } from "./binding-registry.ts";

type Environment = {
  DB?: object;
  WIDEFLEET_D1_DB?: string;
  WIDEFLEET_OAUTH?: object;
  WIDEFLEET_OAUTH_SERVICE?: string;
};

const database = { name: "facade" };

const oauth = { name: "oauth" };

const registry = () => {
  const bindings = bindingRegistry();
  bindings.define("DB", database);
  bindings.define("WIDEFLEET_OAUTH", oauth, "WIDEFLEET_OAUTH_SERVICE");

  return bindings;
};

// The importable env as workerd provides it: a proxy for the current request's
// environment.
const importable = (current: () => Environment) =>
  new Proxy<Environment>(
    {},
    {
      // SAFETY: The fixture reads only the environment's declared bindings.
      get: (_, name) => current()[name as keyof Environment],
      has: (_, name) => Reflect.has(current(), name),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_, name) => Reflect.getOwnPropertyDescriptor(current(), name),
      defineProperty: (_, name, attributes) => Reflect.defineProperty(current(), name, attributes),
    },
  );

describe("Platform bindings", () => {
  it("adds them to the environment of each request, not only the first", () => {
    const bindings = registry();
    const first: Environment = { WIDEFLEET_D1_DB: "binding", WIDEFLEET_OAUTH_SERVICE: "oauth" };
    let current = first;
    const env = importable(() => current);

    // Module evaluation completes the environment of the loading request.
    bindings.install(env);
    expect(first.DB).toBe(database);

    // Cloudflare can serve a later request with a new environment object.
    const next: Environment = { WIDEFLEET_D1_DB: "binding", WIDEFLEET_OAUTH_SERVICE: "oauth" };
    current = next;
    expect(env.DB).toBeUndefined();

    bindings.install(env);
    expect([env.DB, next.DB, next.WIDEFLEET_OAUTH]).toEqual([database, database, oauth]);
    expect(Object.keys(env).sort()).toEqual([
      "DB",
      "WIDEFLEET_D1_DB",
      "WIDEFLEET_OAUTH",
      "WIDEFLEET_OAUTH_SERVICE",
    ]);
  });

  it("adds a binding only where its service exists and keeps existing properties", () => {
    const bindings = registry();
    const own = { name: "app" };
    const received: Environment = { DB: own };

    expect(bindings.apply(received)).toBe(received);
    expect(received).toEqual({ DB: own });
  });

  it("copies an environment that cannot be extended", () => {
    const bindings = registry();
    const received: Environment = Object.freeze({ WIDEFLEET_D1_DB: "binding" });

    expect(bindings.apply(received)).toEqual({ WIDEFLEET_D1_DB: "binding", DB: database });
  });
});
