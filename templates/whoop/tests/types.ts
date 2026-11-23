// Compiled by `pnpm typecheck`: the results a consuming app sees, as template.md shows them.
import type Whoop from "../src/app.ts";

declare const whoop: Whoop;

export const examples = async () => {
  const cycles = await whoop.listCycles({ start: "2026-11-01T00:00:00.000Z", limit: 10 });

  if (cycles.status === "connected") {
    for (const cycle of cycles.data.records ?? []) {
      const strain: number | undefined = cycle.score?.strain;
      void strain;
    }

    // A later page continues at the earlier answer's token.
    if (cycles.data.next_token) await whoop.listCycles({ nextToken: cycles.data.next_token });
  }

  const recovery = await whoop.getCycleRecovery({ cycleId: 93845 });

  if (recovery.status === "connected") void recovery.data.score?.recovery_score;

  if (recovery.status === "whoop_error") void recovery.error.status;

  // @ts-expect-error A cycle needs its ID.
  await whoop.getCycle({});
  // @ts-expect-error Limits are numbers.
  await whoop.listWorkouts({ limit: "10" });

  const revoked = await whoop.revokeAccess();

  if (revoked.resultType === "input_required") void revoked.inputRequests.approve.message;
};
