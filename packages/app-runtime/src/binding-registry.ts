type Entry = { value: object; requires: string | undefined };

/**
 * Properties the platform adds to an app's environment, such as D1 facades and
 * managed OAuth. Cloudflare can hand an app a new environment object for each
 * request, so they are added to every environment the app receives, not once
 * when its modules load.
 */
export const bindingRegistry = () => {
  const entries = new Map<string, Entry>();

  const missing = <T extends object>(target: T) =>
    [...entries].filter(
      ([name, entry]) =>
        !Object.prototype.hasOwnProperty.call(target, name) &&
        (entry.requires === undefined || entry.requires in target),
    );

  const descriptor = <V extends object>(value: V) => ({
    value,
    enumerable: true,
    writable: true,
    // Configurable, so reading it through the importable env's proxy keeps
    // that proxy's invariants.
    configurable: true,
  });

  return {
    /** Adds `name` to environments, or only to those that have `requires`. */
    define<V extends object>(name: string, value: V, requires?: string) {
      entries.set(name, { value, requires });
    },
    /** Adds the missing properties to `target` in place. */
    install<T extends object>(target: T) {
      for (const [name, entry] of missing(target))
        Reflect.defineProperty(target, name, descriptor(entry.value));
    },
    /** Returns `target` with every property, copied when it cannot be extended. */
    apply<T extends object>(target: T): T {
      if (Object.isExtensible(target)) {
        this.install(target);

        return target;
      }

      const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(target));

      for (const [name, entry] of missing(target))
        Object.defineProperty(copy, name, descriptor(entry.value));

      // SAFETY: The copy carries every own property descriptor of `target`.
      return copy as T;
    },
  };
};
