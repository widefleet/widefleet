// Compiled by `pnpm typecheck`: the results a consuming app sees for typed selections.
import type GoogleDrive from "../src/app.ts";

declare const drive: GoogleDrive;

export const selections = async () => {
  const files = await drive.filesList(
    {
      q: "mimeType = 'application/pdf' and trashed = false",
      pageSize: 20,
      orderBy: "modifiedTime desc",
    },
    { files: { id: true, name: true, modifiedTime: true }, nextPageToken: true },
  );

  if (files.status === "connected") {
    const name: string | undefined = files.data.files?.[0]?.name;
    // @ts-expect-error Not selected.
    void files.data.files?.[0]?.size;
    void name;
  }

  // @ts-expect-error File has no such field.
  await drive.filesGet({ fileId: "f" }, { notAField: true });
  // @ts-expect-error Content methods take no selection.
  await drive.filesGetContent({ fileId: "f" }, { id: true });
  // @ts-expect-error The file ID is required.
  await drive.filesGetContent({});
  // @ts-expect-error Uploads need their content.
  await drive.filesCreateWithContent({ body: { name: "a.txt" } }, { id: true });

  const content = await drive.filesGetContent({ fileId: "f" });

  if (content.status === "connected" && "base64" in content.data) {
    const base64: string = content.data.base64;
    void base64;
  }
};

// The examples in template.md.
export const examples = async () => {
  const found = await drive.filesList(
    { q: "name contains 'budget' and trashed = false", pageSize: 10 },
    { files: { id: true, name: true, mimeType: true } },
  );

  if (found.status === "connected")
    for (const file of found.data.files ?? []) void [file.name, file.mimeType];

  const created = await drive.filesCreateWithContent(
    {
      body: { name: "notes.md", parents: ["FOLDER-ID"] },
      content: { mimeType: "text/markdown", text: "# Notes" },
    },
    { id: true, webViewLink: true },
  );

  void created;
  const text = await drive.filesExport({ fileId: "DOC-ID", mimeType: "text/plain" });
  void text;
};
