import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { captureError } from "./lib/server/capture-error.ts";

const requestErrors = createMiddleware().server(async ({ next, request, context }) => {
  try {
    return await next();
  } catch (cause) {
    captureError(cause, context, request);
    throw cause;
  }
});

const errors = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (cause) {
    captureError(cause);
    throw cause;
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    requestErrors,
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
  ],
  functionMiddleware: [errors],
}));
