// Use the installation's authenticated runtime management service. The runtime
// persists each app's gate before acknowledging; its catalog alarms pause runs.
export const publishAppExecutionAvailability = async (
  runtime: { fetch: typeof fetch },
  appIds: readonly string[],
  blocked: boolean,
) => {
  const failures: unknown[] = [];

  for (let offset = 0; offset < appIds.length; offset += 10) {
    const results = await Promise.allSettled(
      appIds.slice(offset, offset + 10).map(async (appId) => {
        const response = await runtime.fetch(
          "https://runtime.internal/.well-known/widefleet/execution",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ appId, blocked }),
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          },
        );

        await response.body?.cancel();

        // A legacy runtime may return an unrelated successful response. Only the
        // new endpoint's acknowledgement confirms the durable gate was written.
        if (response.status !== 204)
          throw new Error(
            `Execution availability publication failed for ${appId} (HTTP ${response.status})`,
          );
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }

  if (failures.length)
    throw new AggregateError(failures, "Execution availability publication failed");
};
