// Compiled by `pnpm typecheck`: the results a consuming app sees.
import type Outlook from "../src/app.ts";

declare const outlook: Outlook;

export const examples = async () => {
  const inbox = await outlook.listFolderMessages({
    mailFolderId: "inbox",
    $top: 10,
    $filter: "isRead eq false",
    $select: ["subject", "from", "receivedDateTime"],
  });

  if (inbox.status === "connected")
    for (const message of inbox.data.value ?? []) {
      const subject: string | null | undefined = message.subject;
      const sender: string | null | undefined = message.from?.emailAddress?.address;
      void [subject, sender];
    }

  const week = await outlook.calendarView({
    startDateTime: "2026-12-01T00:00:00Z",
    endDateTime: "2026-12-08T00:00:00Z",
  });

  if (week.status === "connected") void week.data.value?.[0]?.start?.dateTime;

  // @ts-expect-error A message needs its ID.
  await outlook.getMessage({});
  // @ts-expect-error Query options have Graph's types.
  await outlook.listMessages({ $top: "5" });

  const sent = await outlook.sendMail({
    body: {
      Message: {
        subject: "Agenda",
        body: { contentType: "text", content: "See you at ten." },
        toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
      },
    },
  });

  if (sent.resultType === "input_required") void sent.inputRequests.approve.message;

  // A later page needs only its address.
  await outlook.calendarView({
    nextLink: "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=1",
  });

  const attached = await outlook.addAttachment({
    messageId: "draft-1",
    body: {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "notes.txt",
      contentType: "text/plain",
      contentBytes: "SGVsbG8=",
    },
  });

  if (attached.status === "connected" && "contentBytes" in attached.data)
    void attached.data.contentBytes;

  // An item attachment carries the event it attaches.
  await outlook.addAttachment({
    messageId: "draft-1",
    body: {
      "@odata.type": "#microsoft.graph.itemAttachment",
      name: "Planning",
      item: {
        "@odata.type": "#microsoft.graph.event",
        subject: "Planning",
        start: { dateTime: "2026-12-01T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-12-01T11:00:00", timeZone: "UTC" },
      },
    },
  });

  // A message sends its file and item attachments inline.
  await outlook.sendMail({
    body: {
      Message: {
        subject: "Report",
        toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "report.txt",
            contentType: "text/plain",
            contentBytes: "SGVsbG8=",
          },
          {
            "@odata.type": "#microsoft.graph.itemAttachment",
            name: "Earlier message",
            item: { "@odata.type": "#microsoft.graph.message", subject: "Earlier" },
          },
        ],
      },
    },
  });
};
