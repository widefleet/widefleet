// Compiled by `pnpm typecheck`: the results a consuming app sees, as template.md shows them.
import type Teams from "../src/app.ts";

declare const teams: Teams;

export const examples = async () => {
  const joined = await teams.listJoinedTeams();
  const team = joined.status === "connected" ? joined.data.value?.[0] : undefined;

  if (team?.id) {
    const general = await teams.getPrimaryChannel({ teamId: team.id });

    if (general.status === "connected" && general.data.id) {
      const messages = await teams.listChannelMessages({
        teamId: team.id,
        channelId: general.data.id,
        $top: 10,
      });

      if (messages.status === "connected")
        for (const message of messages.data.value ?? []) {
          const sender: string | null | undefined = message.from?.user?.displayName;
          const content: string | null | undefined = message.body?.content;
          void [sender, content];
        }
    }
  }

  const me = await teams.me();

  if (me.status === "connected" && me.data.id) {
    const member = (user: string) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${user}')`,
    });

    const chat = await teams.createChat({
      body: { chatType: "oneOnOne", members: [member(me.data.id), member("bob@example.com")] },
    });

    if (chat.status === "connected" && chat.data.id)
      await teams.sendChatMessage({
        chatId: chat.data.id,
        body: { body: { contentType: "text", content: "Hello" } },
      });

    if (chat.resultType === "input_required") void chat.inputRequests.approve.message;
  }

  // @ts-expect-error A chat message needs its chat.
  await teams.sendChatMessage({ body: { body: { content: "Hello" } } });
  // @ts-expect-error Message bodies are text or HTML.
  await teams.sendChatMessage({ chatId: "c", body: { body: { contentType: "markdown" } } });
};
