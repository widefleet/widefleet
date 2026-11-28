// How the template generator offers Notion's API for the person who connects
// their account: pages and their content, databases, data sources and views,
// comments, file uploads, users, meeting notes, Custom Agents and their
// sessions, and Agent Skills. This file lists the operations the template
// offers, by operation ID, with their method names. Operations that change data
// name the change they make, which decides when they ask the user first (see
// src/approval.ts). Only additions that leave existing data as it was count as
// `create`.
//
// Not offered, because they cannot work with the person's OAuth token: the OAuth
// endpoints, which take the OAuth client's own credentials and which the
// template uses itself; deleting a Custom Agent and changing its credit limit,
// and creating a full-page meeting note or linking it to a calendar event,
// which only a personal access token or a Notion Worker may do; and Notion's
// Admin API, which takes an organization bot token.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source: "https://developers.notion.com/openapi.json",
  service: {
    name: "Notion",
    className: "NotionApi",
    result: "NotionResult",
    properties: "NotionProperties",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

// Notion describes a file part as an empty object; it is the file's bytes.
const filePart = (description: string) =>
  ({ type: "string", format: "binary", description }) as const;

// Every method can opt into Notion's betas, which some request fields require.
const headers = {
  notionBeta: {
    name: "Notion-Beta",
    description:
      "Beta flags to opt into, such as `status-group-filters-2026-10-06`, separated by commas.",
  },
} as const;

const offered = {
  // Users
  "get-self": { name: "getBotUser" },
  "get-user": { name: "getUser" },
  "get-users": { name: "listUsers" },

  // Pages and page content
  "post-page": { name: "createPage", change: "create" },
  "retrieve-a-page": { name: "getPage" },
  // Changes properties, icon, cover and lock, applies a template, or moves the
  // page to the trash.
  "patch-page": { name: "updatePage", change: "update" },
  "move-page": { name: "movePage", change: "update" },
  // Property IDs come URL-encoded from Notion and go back as they are.
  "retrieve-a-page-property": { name: "getPageProperty", encodedPathParameters: ["property_id"] },
  "retrieve-page-markdown": { name: "getPageMarkdown" },
  "update-page-markdown": { name: "updatePageMarkdown", change: "update" },
  "retrieve-async-task": { name: "getAsyncTask" },

  // Blocks
  "retrieve-a-block": { name: "getBlock" },
  "update-a-block": { name: "updateBlock", change: "update" },
  // Moves the block to the trash.
  "delete-a-block": { name: "deleteBlock", change: "delete" },
  "get-block-children": { name: "listBlockChildren" },
  "patch-block-children": { name: "appendBlockChildren", change: "create" },

  // Databases and data sources
  "create-database": { name: "createDatabase", change: "create" },
  "retrieve-database": { name: "getDatabase" },
  "update-database": { name: "updateDatabase", change: "update" },
  "create-a-database": { name: "createDataSource", change: "create" },
  "retrieve-a-data-source": { name: "getDataSource" },
  "update-a-data-source": { name: "updateDataSource", change: "update" },
  "post-database-query": { name: "queryDataSource", change: "read" },
  "list-data-source-templates": { name: "listDataSourceTemplates" },

  // Views and their queries; a view query keeps its results for paging until it expires.
  "list-views": { name: "listViews" },
  "create-view": { name: "createView", change: "create" },
  "retrieve-a-view": { name: "getView" },
  "update-a-view": { name: "updateView", change: "update" },
  "delete-view": { name: "deleteView", change: "delete" },
  "create-view-query": { name: "queryView", change: "read" },
  "get-view-query-results": { name: "getViewQueryResults" },
  "delete-view-query": { name: "deleteViewQuery", change: "read" },

  // Search
  "post-search": { name: "search", change: "read" },

  // Comments
  "create-a-comment": { name: "createComment", change: "create" },
  "list-comments": { name: "listComments" },
  "retrieve-comment": { name: "getComment" },
  "update-a-comment": { name: "updateComment", change: "update" },
  "delete-a-comment": { name: "deleteComment", change: "delete" },

  // File uploads, which pages, blocks and comments then attach
  "create-file": { name: "createFileUpload", change: "create" },
  "list-file-uploads": { name: "listFileUploads" },
  "upload-file": {
    name: "sendFileUpload",
    change: "create",
    form: {
      type: "object",
      properties: {
        file: filePart("The file's bytes, or one part of them for a multi-part upload."),
        part_number: {
          type: "string",
          description:
            "For a multi-part upload, the number of this part, an integer from 1 to 1,000.",
        },
      },
      required: ["file"],
    },
  },
  "complete-file-upload": { name: "completeFileUpload", change: "create" },
  "retrieve-file-upload": { name: "getFileUpload" },

  // Custom emojis
  "list-custom-emojis": { name: "listCustomEmojis" },

  // Meeting notes
  "create-meeting-note": { name: "createMeetingNote", change: "create" },
  "query-meeting-notes": { name: "queryMeetingNotes", change: "read" },

  // Custom Agents shared with the connection
  "query-agents": { name: "queryAgents", change: "read" },
  "get-agent": { name: "getAgent" },
  "update-agent": { name: "updateAgent", change: "update" },
  // Deprecated by Notion for `updateAgent`'s `status`, and still served.
  "update-agent-status": { name: "updateAgentStatus", change: "update" },
  "get-agent-insights": { name: "getAgentInsights" },
  "agent-batch": { name: "batchAgents", change: "update" },

  // Sessions with Custom Agents; a message can start an agent's run.
  "update-session": { name: "sendSessionMessage", change: "send" },
  "retrieve-session": { name: "getSession" },
  "query-sessions": { name: "querySessions", change: "read" },
  "query-session-events": { name: "querySessionEvents", change: "read" },
  "cancel-session": { name: "cancelSession", change: "update" },

  // Agent Skills: plugins and skills download as archives from signed addresses.
  "list-skills-plugins": { name: "listSkillPlugins" },
  "get-plugin-directory": { name: "getPluginDirectory" },
  "get-skill-directory": { name: "getSkillDirectory" },
  // Replaces the skill's files with the archive's.
  "upload-skill": {
    name: "uploadSkill",
    change: "update",
    form: {
      type: "object",
      properties: {
        file: filePart("The skill directory as a gzip-compressed tar archive, up to 20 MiB."),
      },
      required: ["file"],
    },
  },
} satisfies Record<
  string,
  {
    name: string;
    change?: Change | "read";
    description?: string;
    form?: object;
    encodedPathParameters?: string[];
  }
>;

export const operations = Object.fromEntries(
  Object.entries(offered).map(([id, rule]) => [id, { ...rule, headers }]),
);
