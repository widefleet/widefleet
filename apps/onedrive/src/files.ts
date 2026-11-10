import { z } from "zod";

export const itemId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9!_-]+$/);

export const folderInput = z.object({
  folderId: itemId.default("root"),
  pageUrl: z.url().max(16384).optional(),
});

export const searchInput = z.object({
  query: z.string().trim().min(1).max(1024),
  pageUrl: z.url().max(16384).optional(),
});

export const file = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().nonnegative().optional(),
  webUrl: z.url().optional(),
  lastModifiedDateTime: z.string().optional(),
  folder: z.object({ childCount: z.number().int().nonnegative().optional() }).optional(),
  file: z.object({ mimeType: z.string().optional() }).optional(),
  parentReference: z
    .object({ driveId: z.string().optional(), id: z.string().optional() })
    .optional(),
});

export const filePage = z.object({
  value: z.array(file),
  "@odata.nextLink": z.url().optional(),
});

// Page URLs come from Graph but are supplied back by the caller. Never allow one
// to redirect a user's bearer token to another service or mailbox.
export const continuation = (pageUrl: string, pathname: string) => {
  const url = new URL(pageUrl);

  // Graph may canonicalize /me/drive to /drives/{id} or q= to query= in
  // nextLink. Keep the complete provider URL while restricting it to the same
  // read operation; arbitrary Graph endpoints and other hosts are not allowed.
  const folderPage =
    /^\/v1\.0\/(?:me\/drive|drives\/[a-zA-Z0-9!_-]+)\/(?:root|items\/[a-zA-Z0-9!_-]+)\/children$/.test(
      url.pathname,
    );

  const searchPage =
    /^\/v1\.0\/(?:me\/drive|drives\/[a-zA-Z0-9!_-]+)\/root\/search\((?:q|query)='.*'\)$/.test(
      url.pathname,
    );

  const sameOperation = pathname.endsWith("/children") ? folderPage : searchPage;

  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !sameOperation
  )
    throw new Error("The continuation does not belong to this OneDrive request");

  return url.pathname + url.search;
};

export const folderPath = (input: z.input<typeof folderInput>) => {
  const options = folderInput.parse(input);

  const path =
    options.folderId === "root"
      ? "/v1.0/me/drive/root/children"
      : `/v1.0/me/drive/items/${encodeURIComponent(options.folderId)}/children`;

  return options.pageUrl ? continuation(options.pageUrl, path) : `${path}?$top=100`;
};

export const searchPath = (input: z.input<typeof searchInput>) => {
  const options = searchInput.parse(input);
  const query = encodeURIComponent(options.query.replaceAll("'", "''")).replaceAll("'", "%27");
  const path = `/v1.0/me/drive/root/search(q='${query}')`;

  return options.pageUrl ? continuation(options.pageUrl, path) : `${path}?$top=100`;
};

export const readPage = (value: z.infer<typeof filePage>) => ({
  files: value.value,
  nextPageUrl: value["@odata.nextLink"] ?? null,
});
