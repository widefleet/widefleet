// How the template generator offers Outlook's operations of Microsoft Graph:
// mail, calendars, contacts and mailbox settings of the signed-in user. Graph
// describes far more than Outlook, so this file lists the operations the
// template offers, by operation ID, with their method names. Operations that
// change data name the change they make, which decides when they ask the user
// first (see src/approval.ts). Only additions that leave existing data and
// other people untouched count as `create`; anything that sends mail, invites
// or answers other people is `send`. POST operations that only read are `read`.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source:
    "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml",
  service: {
    name: "Outlook",
    className: "OutlookApi",
    result: "OutlookResult",
    properties: "OutlookProperties",
    typePrefix: "microsoft.graph.",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

// Graph describes attachments by their base type; these are the kinds it sends and accepts.
const attachmentTypes = [
  "microsoft.graph.fileAttachment",
  "microsoft.graph.itemAttachment",
  "microsoft.graph.referenceAttachment",
];

export const operations = {
  // Messages
  "me.ListMessages": {
    name: "listMessages",
    description:
      "List the messages in the user's mailbox. Use `$filter`, `$search`, `$orderby` and `$select` to narrow them.",
  },
  "me.GetMessages": {
    name: "getMessage",
    description: "Get a message, with its body, recipients and flags.",
  },
  "me.GetMessagesContent": {
    name: "getMessageMime",
    description: "Get a message as MIME, as it was sent.",
  },
  "me.messages.delta": { name: "messagesDelta" },
  "me.CreateMessages": {
    name: "createDraft",
    change: "create",
    description: "Create a draft in the Drafts folder. `sendDraft` sends it.",
  },
  "me.UpdateMessages": {
    name: "updateMessage",
    change: "update",
    description:
      "Update a message: a draft's content and recipients, or any message's flags, categories and read state.",
  },
  "me.DeleteMessages": {
    name: "deleteMessage",
    change: "delete",
    description: "Delete a message: it moves to Deleted Items.",
  },
  "me.messages.message.send": { name: "sendDraft", change: "send" },
  "me.sendMail": { name: "sendMail", change: "send" },
  "me.messages.message.reply": { name: "reply", change: "send" },
  "me.messages.message.replyAll": { name: "replyAll", change: "send" },
  "me.messages.message.forward": { name: "forward", change: "send" },
  "me.messages.message.createReply": { name: "createReplyDraft", change: "create" },
  "me.messages.message.createReplyAll": { name: "createReplyAllDraft", change: "create" },
  "me.messages.message.createForward": { name: "createForwardDraft", change: "create" },
  "me.messages.message.move": { name: "moveMessage", change: "update" },
  "me.messages.message.copy": { name: "copyMessage", change: "create" },
  "me.messages.ListAttachments": { name: "listAttachments" },
  "me.messages.GetAttachments": { name: "getAttachment", result: attachmentTypes },
  // Adds an attachment to a draft.
  "me.messages.CreateAttachments": {
    name: "addAttachment",
    change: "create",
    body: attachmentTypes,
    result: attachmentTypes,
  },
  "me.messages.DeleteAttachments": { name: "deleteAttachment", change: "delete" },

  // Mail folders
  "me.ListMailFolders": { name: "listMailFolders" },
  "me.GetMailFolders": { name: "getMailFolder" },
  "me.mailFolders.ListChildFolders": { name: "listChildFolders" },
  "me.mailFolders.ListMessages": { name: "listFolderMessages" },
  "me.mailFolders.mailFolder.messages.delta": { name: "folderMessagesDelta" },
  "me.CreateMailFolders": { name: "createMailFolder", change: "create" },
  "me.mailFolders.CreateChildFolders": { name: "createChildFolder", change: "create" },
  "me.UpdateMailFolders": { name: "updateMailFolder", change: "update" },
  "me.DeleteMailFolders": { name: "deleteMailFolder", change: "delete" },
  "me.mailFolders.ListMessageRules": { name: "listMessageRules" },
  "me.mailFolders.GetMessageRules": { name: "getMessageRule" },
  // Rules act on incoming mail and can forward it.
  "me.mailFolders.CreateMessageRules": { name: "createMessageRule", change: "update" },
  "me.mailFolders.UpdateMessageRules": { name: "updateMessageRule", change: "update" },
  "me.mailFolders.DeleteMessageRules": { name: "deleteMessageRule", change: "delete" },

  // Calendars and events
  "me.ListCalendars": { name: "listCalendars" },
  "me.GetCalendars": { name: "getCalendar" },
  "me.CreateCalendars": { name: "createCalendar", change: "create" },
  "me.UpdateCalendars": { name: "updateCalendar", change: "update" },
  "me.DeleteCalendars": { name: "deleteCalendar", change: "delete" },
  "me.ListCalendarView": { name: "calendarView" },
  "me.calendars.ListCalendarView": { name: "calendarViewOfCalendar" },
  "me.ListEvents": { name: "listEvents" },
  "me.calendars.ListEvents": { name: "listCalendarEvents" },
  "me.GetEvents": { name: "getEvent" },
  "me.events.ListInstances": { name: "listInstances" },
  "me.CreateEvents": {
    name: "createEvent",
    change: "send",
    description:
      "Create an event in the user's default calendar. Its attendees receive an invitation.",
  },
  "me.calendars.CreateEvents": { name: "createCalendarEvent", change: "send" },
  // Sends updates to the attendees of an event the user organizes.
  "me.UpdateEvents": { name: "updateEvent", change: "update" },
  "me.DeleteEvents": { name: "deleteEvent", change: "delete" },
  // Answer the organizer, or tell the attendees.
  "me.events.event.accept": { name: "acceptEvent", change: "send" },
  "me.events.event.tentativelyAccept": { name: "tentativelyAcceptEvent", change: "send" },
  "me.events.event.decline": { name: "declineEvent", change: "send" },
  "me.events.event.cancel": { name: "cancelEvent", change: "send" },
  "me.events.event.forward": { name: "forwardEvent", change: "send" },
  "me.events.event.dismissReminder": { name: "dismissReminder", change: "update" },
  "me.events.event.snoozeReminder": { name: "snoozeReminder", change: "update" },
  "me.findMeetingTimes": { name: "findMeetingTimes", change: "read" },
  "me.calendar.getSchedule": { name: "getSchedule", change: "read" },

  // Contacts
  "me.ListContacts": { name: "listContacts" },
  "me.GetContacts": { name: "getContact" },
  "me.CreateContacts": { name: "createContact", change: "create" },
  "me.UpdateContacts": { name: "updateContact", change: "update" },
  "me.DeleteContacts": { name: "deleteContact", change: "delete" },
  "me.ListContactFolders": { name: "listContactFolders" },

  // Settings
  "me.GetMailboxSettings": { name: "mailboxSettings" },
  // Includes automatic replies, which answer everyone who writes.
  "me.UpdateMailboxSettings": { name: "updateMailboxSettings", change: "update" },
  "me.outlook.ListMasterCategories": { name: "listCategories" },
} satisfies Record<
  string,
  {
    name: string;
    change?: Change | "read";
    description?: string;
    body?: readonly string[];
    result?: readonly string[];
  }
>;
