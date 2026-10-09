import { z } from "zod";
import type { WorkflowValue } from "./workflow-protocol.ts";

// Management uses JSON; app RPC keeps native structured-clone values. Tagged
// values make non-JSON outputs inspectable without breaking status queries.
export const workflowJson = (value: WorkflowValue) => {
  const seen = new WeakMap<object, number>();
  let next = 0;

  const text = JSON.stringify(value, (_key, item: WorkflowValue) => {
    const integer = z.bigint().safeParse(item);

    if (integer.success) return { $type: "BigInt", value: integer.data.toString() };
    const object = z.instanceof(Object).safeParse(item);

    if (object.success) {
      const reference = seen.get(object.data);

      if (reference !== undefined) return { $ref: reference };
      seen.set(object.data, next++);
    }

    if (item instanceof Map) return { $type: "Map", entries: Array.from(item.entries()) };

    if (item instanceof Set) return { $type: "Set", values: Array.from(item.values()) };

    if (item instanceof ArrayBuffer)
      return { $type: "ArrayBuffer", bytes: Array.from(new Uint8Array(item)) };

    if (ArrayBuffer.isView(item))
      return {
        $type: item.constructor.name,
        bytes: Array.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)),
      };

    if (item instanceof Error) return { $type: "Error", name: item.name, message: item.message };

    return item;
  });

  return z.json().parse(JSON.parse(text ?? "null"));
};
