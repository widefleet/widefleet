/**
 * Gives `target` every own property of `source` it lacks. An environment that
 * cannot be extended is copied instead, with its own properties taking
 * precedence.
 *
 * The importable env is a proxy for the Worker's base environment. Reading its
 * property descriptors breaks proxy invariants for non-configurable bindings,
 * so only its keys and values are read.
 */
export const mergeEnvironment = <S extends object, T extends object>(source: S, target: T): T => {
  if (Object.is(target, source)) return target;

  const missing: PropertyDescriptorMap = {};

  for (const name of Reflect.ownKeys(source)) {
    if (Object.prototype.hasOwnProperty.call(target, name)) continue;

    // SAFETY: `name` is one of the source's own keys, so it indexes the source.
    const value = source[name as keyof S];
    missing[name] = { value, enumerable: true, writable: true, configurable: true };
  }

  if (Object.isExtensible(target)) return Object.defineProperties(target, missing);

  const merged = Object.defineProperties(
    {},
    { ...Object.getOwnPropertyDescriptors(target), ...missing },
  );

  // SAFETY: The copy carries every own property descriptor of `target`.
  return merged as T;
};
