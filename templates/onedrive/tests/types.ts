// Compiled by `pnpm typecheck`: the results a consuming app sees, as template.md shows them.
import type OneDrive from "../src/app.ts";

declare const onedrive: OneDrive;

export const examples = async () => {
  const drive = await onedrive.myDrive();

  if (drive.status === "connected" && drive.data.id) {
    const files = await onedrive.listChildren({
      driveId: drive.data.id,
      driveItemId: "root",
      $top: 50,
      $select: ["id", "name", "size", "file", "folder"],
    });

    if (files.status === "connected")
      for (const item of files.data.value ?? []) {
        const name: string | null | undefined = item.name;
        const size: number | null | undefined = item.size;
        void [name, size];
      }
  }

  const content = await onedrive.getContent({ driveId: "d", driveItemId: "i" });

  if (content.status === "connected" && "downloadUrl" in content.data) {
    const url: string = content.data.downloadUrl;
    void url;
  }

  // @ts-expect-error Items need their drive.
  await onedrive.getItem({ driveItemId: "i" });
  // @ts-expect-error Query options have Graph's types.
  await onedrive.listChildren({ driveId: "d", driveItemId: "root", $top: "5" });

  const created = await onedrive.createChild({
    driveId: "d",
    driveItemId: "root",
    body: { name: "Reports", folder: {} },
  });

  if (created.resultType === "input_required") void created.inputRequests.approve.message;
};
