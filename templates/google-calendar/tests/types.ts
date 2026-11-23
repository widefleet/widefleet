// Compiled by `pnpm typecheck`: the results a consuming app sees for typed selections.
import type GoogleCalendar from "../src/app.ts";

declare const calendar: GoogleCalendar;

export const selections = async () => {
  const events = await calendar.eventsList(
    {
      calendarId: "primary",
      timeMin: "2026-12-01T00:00:00Z",
      singleEvents: true,
      orderBy: "startTime",
    },
    { items: { id: true, summary: true, start: { dateTime: true } }, nextPageToken: true },
  );

  if (events.status === "connected") {
    const summary: string | undefined = events.data.items?.[0]?.summary;
    const start: string | undefined = events.data.items?.[0]?.start?.dateTime;
    // @ts-expect-error Not selected.
    void events.data.items?.[0]?.location;
    void [summary, start];
  }

  // @ts-expect-error Event has no such field.
  await calendar.eventsGet({ calendarId: "primary", eventId: "e" }, { id: true, notAField: true });
  // @ts-expect-error A related object needs a nested selection.
  await calendar.eventsGet({ calendarId: "primary", eventId: "e" }, { start: true });
  // @ts-expect-error The calendar is required.
  await calendar.eventsGet({ eventId: "e" }, { id: true });
  // @ts-expect-error sendUpdates has fixed choices.
  await calendar.eventsDelete({ calendarId: "primary", eventId: "e", sendUpdates: "everyone" });

  const created = await calendar.eventsInsert(
    { calendarId: "primary", body: { summary: "Review", start: { date: "2026-12-01" } } },
    { id: true, htmlLink: true },
  );

  if (created.resultType === "input_required") void created.inputRequests.approve.message;
};

// The example in template.md.
export const week = async () => {
  const week = await calendar.eventsList(
    {
      calendarId: "primary",
      timeMin: "2026-12-01T00:00:00Z",
      timeMax: "2026-12-08T00:00:00Z",
      singleEvents: true,
      orderBy: "startTime",
    },
    { items: { id: true, summary: true, start: { dateTime: true, date: true } } },
  );

  if (week.status === "connected")
    for (const event of week.data.items ?? []) void [event.summary, event.start?.dateTime];
};
