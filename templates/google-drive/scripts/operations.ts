// How the template generator offers each method of the Google Drive API.
// Review this file when the generator reports a new or removed method.
//
// Every method that is not a GET is listed with the kind of change it makes,
// which decides when it asks the user first (see src/approval.ts), as `read`
// when it only reads, or with the reason it is not offered. Only additions that
// leave existing files and other people untouched count as `create`; sharing
// with people, who are emailed by default, and asking them to approve are
// `send`. GET methods are offered unless listed. Methods that read file
// content also get a `...Content` method; methods that accept uploads get a
// `...WithContent` method with the same change.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "discovery",
  source: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  service: {
    name: "Google Drive",
    className: "GoogleDriveApi",
    result: "GoogleDriveResult",
    properties: "GoogleDriveProperties",
  },
} as const;

/** Full access to the user's files, which every offered method accepts. */
export const scopes = ["https://www.googleapis.com/auth/drive"];

/** Why a method is not offered. */
export const reasons = {
  teamDrives: "Replaced by the drives methods",
  clientSideEncryption: "Only for client-side encrypted files, which need the user's own keys",
  installedApps: "Lists the user's installed Drive apps, which needs its own scope",
} as const;

type Hidden = { hidden: keyof typeof reasons };

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  // Grants or refuses someone's request for access.
  "drive.accessproposals.resolve": "update",
  // Shares with people and, unless sendNotificationEmail is false, emails them.
  "drive.permissions.create": "send",
  "drive.permissions.update": "update",
  "drive.permissions.delete": "delete",
  // Push notifications to an address the caller registers.
  "drive.changes.watch": "update",
  "drive.files.watch": "update",
  "drive.channels.stop": "update",
  "drive.comments.create": "create",
  "drive.comments.update": "update",
  "drive.comments.delete": "delete",
  "drive.replies.create": "create",
  "drive.replies.update": "update",
  "drive.replies.delete": "delete",
  // Asks the reviewers to approve the file.
  "drive.approvals.start": "send",
  "drive.approvals.approve": "update",
  "drive.approvals.decline": "update",
  "drive.approvals.cancel": "update",
  // Notifies the approval's initiator and reviewers.
  "drive.approvals.comment": "send",
  "drive.approvals.reassign": "update",
  "drive.revisions.update": "update",
  "drive.revisions.delete": "delete",
  "drive.teamdrives.create": { hidden: "teamDrives" },
  "drive.teamdrives.update": { hidden: "teamDrives" },
  "drive.teamdrives.delete": { hidden: "teamDrives" },
  "drive.teamdrives.get": { hidden: "teamDrives" },
  "drive.teamdrives.list": { hidden: "teamDrives" },
  "drive.drives.create": "create",
  "drive.drives.update": "update",
  "drive.drives.hide": "update",
  "drive.drives.unhide": "update",
  "drive.drives.delete": "delete",
  "drive.files.create": "create",
  "drive.files.copy": "create",
  "drive.files.update": "update",
  "drive.files.modifyLabels": "update",
  // Starts a download of the content, which operationsGet then returns.
  "drive.files.download": "read",
  // Deletes without the trash.
  "drive.files.delete": "delete",
  "drive.files.emptyTrash": "delete",
  "drive.files.generateCseToken": { hidden: "clientSideEncryption" },
  "drive.apps.get": { hidden: "installedApps" },
  "drive.apps.list": { hidden: "installedApps" },
} satisfies Record<string, Change | "read" | Hidden>;
