// Compiled by `pnpm typecheck`: the results a consuming app sees, as template.md shows them.
import type GarminConnect from "../src/app.ts";

declare const garmin: GarminConnect;

export const examples = async () => {
  const runs = await garmin.searchActivities({
    activityType: "running",
    startDate: "2026-11-01",
    endDate: "2026-11-30",
    limit: 20,
  });

  if (runs.status === "connected")
    for (const activity of runs.data) {
      const name: string | undefined = activity.activityName;
      const meters: number | undefined = activity.distance;
      void [name, meters];
    }

  const sleep = await garmin.getDailySleep({ date: "2026-11-20" });

  if (sleep.status === "connected") void sleep.data.sleepTimeSeconds;

  // A day without HRV data has no result.
  const hrv = await garmin.getHrv({ calendarDate: "2026-11-20" });

  if (hrv.status === "connected" && hrv.data) void hrv.data.hrvSummary;

  const file = await garmin.downloadActivity({ activityId: 1001 });

  if (file.status === "connected" && "base64" in file.data) void file.data.base64;

  if (runs.status === "connection_required" || runs.status === "reconnect_required")
    void runs.connectUrl;

  if (runs.status === "garmin_error") void runs.error.status;

  // @ts-expect-error An activity needs its ID.
  await garmin.getActivity({});
  // @ts-expect-error Dates are text in the YYYY-MM-DD format.
  await garmin.listDailySteps({ startDate: 20261101, endDate: "2026-11-28" });
};
