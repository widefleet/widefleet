// The runtime reads the existing organization availability. This call only
// reconciles native pauses; it does not publish another suspension decision.
export const reconcileWorkflowSuspension = async (
  runtime: { reconcileWorkflows: (organizationId: string, appIds: string[]) => Promise<void> },
  organizationId: string,
  appIds: readonly string[],
) => {
  const failures: unknown[] = [];

  for (let offset = 0; offset < appIds.length; offset += 10) {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        runtime.reconcileWorkflows(organizationId, appIds.slice(offset, offset + 10)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Workflow reconciliation timed out")), 10_000);
        }),
      ]);
    } catch (cause) {
      failures.push(cause);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  if (failures.length)
    throw new AggregateError(failures, "Workflow suspension reconciliation failed");
};
