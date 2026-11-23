// How the template generator offers each method of the Google Calendar API.
// Review this file when the generator reports a new or removed method.
//
// Every method that is not a GET is listed with the kind of change it makes,
// which decides when it asks the user first (see src/approval.ts), as `read`
// when it only reads, or with the reason it is not offered. Only additions that
// leave existing data and other people untouched count as `create`; adding an
// event to its guests' calendars is `send`, and sharing a calendar is an update.
// GET methods are offered unless listed.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "discovery",
  source: "https://calendar-json.googleapis.com/$discovery/rest?version=v3",
  service: {
    name: "Google Calendar",
    className: "GoogleCalendarApi",
    result: "GoogleCalendarResult",
    properties: "GoogleCalendarProperties",
  },
} as const;

/** Why a method is not offered. */
export const reasons = {} as const;

type Hidden = { hidden: keyof typeof reasons };

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  // Sharing a calendar changes who can see it.
  "calendar.acl.insert": "update",
  "calendar.acl.update": "update",
  "calendar.acl.patch": "update",
  "calendar.acl.delete": "delete",
  // Push notifications to an address the caller registers.
  "calendar.acl.watch": "update",
  "calendar.calendarList.watch": "update",
  "calendar.events.watch": "update",
  "calendar.settings.watch": "update",
  "calendar.channels.stop": "update",
  // Adds an existing calendar to the user's list.
  "calendar.calendarList.insert": "create",
  "calendar.calendarList.update": "update",
  "calendar.calendarList.patch": "update",
  // Removes a calendar from the user's list; the calendar stays.
  "calendar.calendarList.delete": "delete",
  "calendar.calendars.insert": "create",
  "calendar.calendars.update": "update",
  "calendar.calendars.patch": "update",
  "calendar.calendars.delete": "delete",
  // Deletes every event of the primary calendar.
  "calendar.calendars.clear": "delete",
  "calendar.calendars.transferOwnership": "update",
  // Adds the event to its guests' calendars and, with sendUpdates, emails them.
  "calendar.events.insert": "send",
  // Creates an event from text, without guests.
  "calendar.events.quickAdd": "create",
  // Adds a private copy of an existing event.
  "calendar.events.import": "create",
  "calendar.events.update": "update",
  "calendar.events.patch": "update",
  "calendar.events.move": "update",
  "calendar.events.delete": "delete",
  "calendar.freebusy.query": "read",
} satisfies Record<string, Change | "read" | Hidden>;
