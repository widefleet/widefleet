import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { workloadControlPath } from "@platform/app-runtime/workload";
import { publishWorkloadAdmission } from "./workload-publication.ts";

export const startWorkloadPublication = (
  database: Parameters<typeof publishWorkloadAdmission>[0],
  configuration: Parameters<typeof publishWorkloadAdmission>[1],
  extension: Parameters<typeof publishWorkloadAdmission>[2],
  report: (error: Error) => void,
) => {
  let stopped = false;
  let pending: Promise<void> | undefined;

  const publish = () => {
    if (stopped || pending) return;
    pending = publishWorkloadAdmission(database, configuration, extension, async (body) => {
      const key = (
        await readFile(join(configuration.PLATFORM_RUNTIME_DIRECTORY, "control-token"), "utf8")
      ).trim();

      const response = await fetch(
        new URL(workloadControlPath, configuration.PLATFORM_APP_RUNTIME_URL),
        {
          method: "PUT",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );

      await response.body?.cancel();

      if (!response.ok)
        throw new Error(`Workload configuration publication failed (${response.status})`);
    })
      .catch((cause: unknown) => report(cause instanceof Error ? cause : new Error(String(cause))))
      .finally(() => {
        pending = undefined;
      });
  };

  const timer = setInterval(publish, 60_000);
  timer.unref();
  publish();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
};
