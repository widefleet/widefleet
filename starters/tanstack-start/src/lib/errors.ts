import { z } from "zod";

export const browserError = z.strictObject({
  id: z.uuid(),
  buildId: z.string().min(1).max(128),
  message: z.string().min(1).max(4096),
  stack: z.string().max(16384).nullable(),
  route: z
    .string()
    .max(1024)
    .regex(/^\/(?!\/)[^?#]*$/),
});

export const describeError = (cause: unknown) => {
  if (cause instanceof Error) {
    let stack = cause.stack ?? `${cause.name}: ${cause.message}`;
    let current = cause.cause;
    const seen = new Set([cause]);

    while (current instanceof Error && !seen.has(current) && seen.size < 5) {
      seen.add(current);
      stack += `\nCaused by: ${current.stack ?? current.message}`;
      current = current.cause;
    }

    return { message: cause.message.slice(0, 4096) || cause.name, stack: stack.slice(0, 16384) };
  }

  const reported = z.object({ message: z.string(), stack: z.string().optional() }).safeParse(cause);

  if (reported.success)
    return {
      message: reported.data.message.slice(0, 4096) || "Unknown error",
      stack: reported.data.stack?.slice(0, 16384) ?? null,
    };
  const text = z.string().safeParse(cause);

  return {
    message: text.success ? text.data.slice(0, 4096) || "Unknown error" : "Non-Error exception",
    stack: null,
  };
};
