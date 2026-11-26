// Compiled by `pnpm typecheck`: the results a consuming app sees.
import type Strava from "../src/app.ts";

declare const strava: Strava;

export const examples = async () => {
  const recent = await strava.listActivities({ after: 1764547200, per_page: 10 });

  if (recent.status === "connected")
    for (const activity of recent.data) {
      const name: string | undefined = activity.name;
      const distance: number | undefined = activity.distance;
      const id: string | undefined = activity.id_str;
      void [name, distance, id];
    }

  // IDs may be numbers or, beyond what a JSON number holds exactly, strings.
  await strava.getActivity({ id: "18014398509481985" });

  const streams = await strava.getActivityStreams({
    id: 1001,
    keys: ["time", "heartrate"],
    key_by_type: true,
  });

  if (streams.status === "connected") void streams.data.heartrate?.data;

  // @ts-expect-error An activity needs its ID.
  await strava.getActivity({});
  // @ts-expect-error Stream types are Strava's.
  await strava.getActivityStreams({ id: 1, keys: ["pace"], key_by_type: true });

  const created = await strava.createActivity({
    body: {
      name: "Lunch run",
      sport_type: "Run",
      start_date_local: "2026-11-23T12:00:00Z",
      elapsed_time: 1800,
    },
  });

  if (created.resultType === "input_required") void created.inputRequests.approve.message;

  await strava.createUpload({
    body: { file: { mimeType: "application/gpx+xml", text: "<gpx/>" }, data_type: "gpx" },
  });

  const gpx = await strava.exportRouteGpx({ id: "3344136437584510208" });

  if (gpx.status === "connected" && "text" in gpx.data) void gpx.data.text;
};
