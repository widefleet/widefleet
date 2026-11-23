// How the template generator offers OneDrive's operations of Microsoft Graph.
// Graph describes far more than files, so this file lists the operations the
// template offers, by operation ID, with their method names. Operations that
// change data name the change they make, which decides when they ask the user
// first (see src/approval.ts). Only additions that leave existing data as it
// was count as `create`; sharing an item counts as an update, and inviting
// people, which sends them an email, as `send`.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "openapi",
  source:
    "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml",
  service: {
    name: "OneDrive",
    className: "OneDriveApi",
    result: "OneDriveResult",
    properties: "OneDriveProperties",
    typePrefix: "microsoft.graph.",
  },
} as const;

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  // Drives
  "me.GetDrive": { name: "myDrive" },
  "me.ListDrives": { name: "listDrives" },
  "drives.drive.GetDrive": { name: "getDrive" },
  "drives.drive.recent": { name: "recentItems" },
  "drives.drive.search": { name: "search" },
  "drives.ListSpecial": { name: "listSpecialFolders" },
  "drives.GetSpecial": { name: "getSpecialFolder" },
  "drives.ListFollowing": { name: "listFollowing" },

  // Items
  "drives.GetRoot": { name: "getRoot" },
  "drives.GetItems": { name: "getItem" },
  "drives.items.ListChildren": { name: "listChildren" },
  "drives.drive.items.driveItem.search": { name: "searchFolder" },
  "drives.drive.items.driveItem.delta-fa14": { name: "delta" },
  "drives.items.CreateChildren": { name: "createChild", change: "create" },
  // Renames, moves or changes an item's metadata.
  "drives.UpdateItems": { name: "updateItem", change: "update" },
  // Moves the item to the recycle bin.
  "drives.DeleteItems": { name: "deleteItem", change: "delete" },
  "drives.drive.items.driveItem.permanentDelete": {
    name: "permanentlyDeleteItem",
    change: "delete",
  },
  "drives.drive.items.driveItem.restore": { name: "restoreItem", change: "update" },
  "drives.drive.items.driveItem.copy": { name: "copyItem", change: "create" },

  // Content
  "drives.GetItemsContent": { name: "getContent" },
  // Replaces the file's content.
  "drives.UpdateItemsContent": { name: "replaceContent", change: "update" },
  "drives.drive.items.driveItem.createUploadSession": {
    name: "createUploadSession",
    change: "update",
  },
  "drives.items.ListThumbnails": { name: "listThumbnails" },
  // Creates a short-lived address to embed a preview.
  "drives.drive.items.driveItem.preview": { name: "previewItem", change: "create" },

  // Versions and check-out
  "drives.items.ListVersions": { name: "listVersions" },
  "drives.items.GetVersions": { name: "getVersion" },
  "drives.items.GetVersionsContent": { name: "getVersionContent" },
  "drives.drive.items.driveItem.versions.driveItemVersion.restoreVersion": {
    name: "restoreVersion",
    change: "update",
  },
  "drives.drive.items.driveItem.checkout": { name: "checkOut", change: "update" },
  "drives.drive.items.driveItem.checkin": { name: "checkIn", change: "update" },
  "drives.drive.items.driveItem.discardCheckout": { name: "discardCheckOut", change: "update" },

  // Sharing
  "drives.items.ListPermissions": { name: "listPermissions" },
  "drives.items.GetPermissions": { name: "getPermission" },
  // Makes the item reachable through a link.
  "drives.drive.items.driveItem.createLink": { name: "createLink", change: "update" },
  // Shares the item and, unless told otherwise, emails the people invited.
  "drives.drive.items.driveItem.invite": { name: "invite", change: "send" },
  "drives.items.UpdatePermissions": { name: "updatePermission", change: "update" },
  "drives.items.DeletePermissions": { name: "deletePermission", change: "delete" },

  // Following
  "drives.drive.items.driveItem.follow": { name: "followItem", change: "create" },
  "drives.drive.items.driveItem.unfollow": { name: "unfollowItem", change: "delete" },
} satisfies Record<string, { name: string; change?: Change }>;
