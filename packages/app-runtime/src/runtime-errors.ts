import { waitUntil } from "cloudflare:workers";
import { runtimeExtension } from "#runtime-extension";
import type { RuntimeExtension } from "./runtime-extension.ts";
import type { ParentEnvironment } from "./types.ts";

export const reportRuntimeException = (
  cause: unknown,
  environment: ParentEnvironment,
  context: Parameters<NonNullable<RuntimeExtension["exception"]>>[1],
) => {
  const report = runtimeExtension.exception;

  if (!report) return;
  waitUntil(
    Promise.resolve()
      .then(() =>
        report(cause instanceof Error ? cause : new Error(String(cause)), context, (name, schema) =>
          schema.parse(environment[name]),
        ),
      )
      .catch(() => {
        // Reporting must not replace the original runtime failure.
      }),
  );
};
