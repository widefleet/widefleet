// Compiled by `pnpm typecheck`: the results a consuming app sees for typed selections.
import type Gmail from "../src/app.ts";

declare const gmail: Gmail;

export const selections = async () => {
  const message = await gmail.messagesGet(
    { id: "message-1", format: "full" },
    { id: true, snippet: true, payload: { headers: { name: true, value: true } } },
  );

  if (message.status === "connected") {
    const id: string | undefined = message.data.id;
    const header: string | undefined = message.data.payload?.headers?.[0]?.value;
    // @ts-expect-error Not selected.
    void message.data.threadId;
    void [id, header];
  }

  // @ts-expect-error Message has no such field.
  await gmail.messagesGet({ id: "message-1" }, { id: true, notAField: true });
  // @ts-expect-error A related object needs a nested selection.
  await gmail.messagesGet({ id: "message-1" }, { payload: true });
  // @ts-expect-error The message ID is required.
  await gmail.messagesGet({}, { id: true });

  const sent = await gmail.messagesSend({ body: { raw: "VG86IGEK" } }, { id: true });

  if (sent.resultType === "input_required") void sent.inputRequests.approve.message;

  const deleted = await gmail.messagesDelete({ id: "message-1" });

  if (deleted.status === "connected") {
    const nothing: null = deleted.data;
    void nothing;
  }
};
