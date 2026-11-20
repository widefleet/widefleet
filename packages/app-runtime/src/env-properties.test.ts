import { describe, expect, it } from "vitest";
import { mergeEnvironment } from "./env-merge.ts";

type Environment = {
  DB?: string;
  WIDEFLEET_D1_DB?: string;
  WIDEFLEET_OAUTH?: string;
  PLAIN?: string;
};

// The importable env, after the platform installed its facades on it.
const platform = () => {
  const environment: Environment = { WIDEFLEET_D1_DB: "binding" };
  Object.defineProperty(environment, "DB", { value: "facade", enumerable: true });

  return environment;
};

// The importable env as workerd provides it: a proxy for the Worker's base
// environment, here with a non-configurable binding like the managed OAuth one.
const importable = () => {
  const base = platform();
  Object.defineProperty(base, "WIDEFLEET_OAUTH", { value: "oauth", enumerable: true });

  return new Proxy<Environment>(
    {},
    {
      // SAFETY: The fixture reads only the environment's declared bindings.
      get: (_, name) => base[name as keyof Environment],
      has: (_, name) => Reflect.has(base, name),
      ownKeys: () => Reflect.ownKeys(base),
      getOwnPropertyDescriptor: (_, name) => Reflect.getOwnPropertyDescriptor(base, name),
    },
  );
};

describe("Environment of app entrypoints", () => {
  it("adds the platform's facades to another environment object", () => {
    const received: Environment = { WIDEFLEET_D1_DB: "request binding" };

    expect(mergeEnvironment(platform(), received)).toBe(received);
    expect(received).toEqual({ WIDEFLEET_D1_DB: "request binding", DB: "facade" });
  });

  it("copies an environment that cannot be extended", () => {
    const received: Environment = Object.freeze({ PLAIN: "value", WIDEFLEET_D1_DB: "own" });

    expect(mergeEnvironment(platform(), received)).toEqual({
      DB: "facade",
      PLAIN: "value",
      WIDEFLEET_D1_DB: "own",
    });
  });

  it("reads the importable env through its proxy", () => {
    const received: Environment = {};

    expect(mergeEnvironment(importable(), received)).toEqual({
      WIDEFLEET_D1_DB: "binding",
      DB: "facade",
      WIDEFLEET_OAUTH: "oauth",
    });
  });

  it("keeps the importable env itself unchanged", () => {
    const source = platform();

    expect(mergeEnvironment(source, source)).toBe(source);
  });
});
