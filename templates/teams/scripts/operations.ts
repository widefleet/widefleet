// How the template generator offers Microsoft Teams' operations of Microsoft
// Graph: the signed-in user's chats, and the channels of the teams they belong
// to. Graph describes far more than Teams, so this file lists the operations
// the template offers, by operation ID, with their method names. Operations
// that change data name the change they make, which decides when they ask the
// user first (see src/approval.ts). Everything this template writes reaches
// other people, so every change is `send`.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source:
    "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml",
  service: {
    name: "Teams",
    className: "TeamsApi",
    result: "TeamsResult",
    properties: "TeamsProperties",
    typePrefix: "microsoft.graph.",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

// A new chat names its members inline, each a user bound by address.
export const navigation = {
  "microsoft.graph.chat": { members: ["microsoft.graph.aadUserConversationMember"] },
};

export const bindings = { "microsoft.graph.aadUserConversationMember": ["user"] };

export const operations = {
  "me.user.GetUser": {
    name: "me",
    description: "Get the signed-in user, whose `id` a new chat lists among its members.",
  },

  // Chats
  "me.ListChats": {
    name: "listChats",
    description:
      'List the user\'s one-on-one, group and meeting chats. `$expand: ["members"]` adds their members.',
  },
  "chats.chat.GetChat": { name: "getChat" },
  "chats.chat.CreateChat": {
    name: "createChat",
    change: "send",
    description:
      "Start a one-on-one or group chat with its members, the user included. A one-on-one chat that exists already is returned.",
  },
  // Graph lists chat members by their base type; as for a chat's members, each
  // is typed with the user identity Teams members carry.
  "chats.ListMembers": {
    name: "listChatMembers",
    result: ["microsoft.graph.aadUserConversationMemberCollectionResponse"],
  },
  "chats.ListMessages": {
    name: "listChatMessages",
    description: "List a chat's messages, newest first.",
  },
  "chats.GetMessages": { name: "getChatMessage" },
  "chats.CreateMessages": {
    name: "sendChatMessage",
    change: "send",
    description: "Send a message to a chat.",
  },
  "chats.chat.messages.replyWithQuote": {
    name: "replyWithQuote",
    change: "send",
    description: "Reply in a chat, quoting one or more of its messages.",
  },

  // Teams and channels
  "me.ListJoinedTeams": { name: "listJoinedTeams" },
  "teams.team.GetTeam": { name: "getTeam" },
  "teams.ListChannels": { name: "listChannels" },
  "teams.GetChannels": { name: "getChannel" },
  "teams.GetPrimaryChannel": {
    name: "getPrimaryChannel",
    description: "Get a team's General channel.",
  },
  "teams.channels.ListMessages": {
    name: "listChannelMessages",
    description: "List a channel's messages, without their replies.",
  },
  "teams.channels.GetMessages": { name: "getChannelMessage" },
  "teams.channels.messages.ListReplies": { name: "listReplies" },
  "teams.channels.messages.GetReplies": { name: "getReply" },
  "teams.channels.CreateMessages": {
    name: "sendChannelMessage",
    change: "send",
    description: "Post a new message in a channel.",
  },
  "teams.channels.messages.CreateReplies": {
    name: "replyToChannelMessage",
    change: "send",
    description: "Reply to a message in a channel.",
  },
} satisfies Record<
  string,
  { name: string; change?: Change | "read"; description?: string; result?: readonly string[] }
>;
