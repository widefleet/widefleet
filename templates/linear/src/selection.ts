// Shared by the generated templates: the template generator copies this file into
// each template's src. Edit it in packages/template-generator/src/runtime.

/** Any JSON value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Whether a selection returns a value whole: a primitive, any JSON, an object
 * with arbitrary keys such as `JsonObject`, or a list of those. Objects with
 * named fields take a nested selection, whether declared as interfaces or as
 * type aliases.
 */
export type IsLeaf<V> = [V] extends [never]
  ? false
  : [JsonValue] extends [V]
    ? true
    : [V] extends [string | number | boolean | null]
      ? true
      : [V] extends [readonly (infer E)[]]
        ? IsLeaf<E>
        : string extends keyof V
          ? true
          : false;

/** A union or interface: `$on` selects fields of each concrete type. */
export interface Variants<Types extends { __typename: string }> {
  readonly variants: Types;
}

// A field with arguments is a method of its type; a selection passes them as
// `$args`, which it must when the field requires an argument. Null and undefined
// do not change what a field's selection looks like.
type FieldSelection<V> = [NonNullable<V>] extends [(args: infer A) => infer R]
  ? IsLeaf<NonNullable<R>> extends true
    ? undefined extends A
      ? true | { $args: NonNullable<A> }
      : { $args: A }
    : (undefined extends A ? { $args?: NonNullable<A> } : { $args: A }) &
        ValueSelection<NonNullable<R>>
  : ValueSelection<NonNullable<V>>;

type ValueSelection<V> =
  IsLeaf<V> extends true
    ? true
    : [V] extends [readonly (infer E)[]]
      ? ValueSelection<NonNullable<E>>
      : Selection<V>;

type VariantSelection<U> = U extends { __typename: string }
  ? { [N in U["__typename"]]?: Selection<Extract<U, { __typename: N }>> }
  : never;

/**
 * Fields to return: `true` for a value, a nested selection for a related object,
 * `$args` for a field's arguments and `$on` for the concrete types of a union or
 * interface, such as `{ $on: { Issue: { title: true } } }`.
 */
// A plain mapped type keeps its name in documentation and declaration files.
export type Selection<T> = {
  [K in keyof T as K extends "variants" ? "$on" : K]?: K extends "variants"
    ? VariantSelection<T[K]>
    : FieldSelection<T[K]>;
};

type Keys<T> = T extends unknown ? keyof T : never;

type At<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

/**
 * A selection with each field the allowed selection does not name typed as `never`, so a
 * misspelled field or argument fails to compile, also next to valid ones.
 */
export type Exact<S, Allowed> = S extends readonly unknown[]
  ? S
  : S extends object
    ? { [K in keyof S]: K extends Keys<Allowed> ? Exact<S[K], NonNullable<At<Allowed, K>>> : never }
    : S;

type FieldResult<V, S> = V extends (args: never) => infer R
  ? IsLeaf<NonNullable<R>> extends true
    ? R
    : ValueResult<R, S>
  : ValueResult<V, S>;

/** The result of a selection on a value: each selected field with its type. */
export type ValueResult<V, S> = S extends true
  ? V
  : undefined extends V
    ? ValueResult<Exclude<V, undefined>, S> | undefined
    : null extends V
      ? ValueResult<NonNullable<V>, S> | null
      : V extends (infer E)[]
        ? ValueResult<E, S>[]
        : Selected<V, S>;

/** The fields a selection returns from an object, and `__typename` for each variant. */
export type Selected<T, S> =
  T extends Variants<infer U>
    ? U extends { __typename: infer N extends string }
      ? { __typename: N } & (S extends { $on: { [K in N]: infer V } } ? Selected<U, V> : {}) & {
            [K in keyof S & Exclude<keyof T, "variants">]: FieldResult<T[K], S[K]>;
          }
      : never
    : { [K in keyof S & keyof T]: FieldResult<T[K], S[K]> };
