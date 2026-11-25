import { z } from "zod";
import { isPublicOrigin } from "./sso-origins.ts";

// Provider pictures are small thumbnails. A larger response is not a profile picture.
export const maxPictureBytes = 100 * 1024;

export type Picture = { bytes: Uint8Array<ArrayBuffer>; contentType: string };

const signatures: [contentType: string, matches: (bytes: Uint8Array) => boolean][] = [
  [
    "image/png",
    (bytes) =>
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => bytes[index] === value,
      ),
  ],
  ["image/jpeg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  [
    "image/gif",
    (bytes) => ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6))),
  ],
  [
    "image/webp",
    (bytes) =>
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP",
  ],
];

// The bytes decide the type, never the provider's header. SVG and other scriptable
// formats are not pictures here.
export const pictureFormat = (bytes: Uint8Array) =>
  signatures.find(([, matches]) => matches(bytes))?.[0] ?? null;

const readPicture = async (response: Response): Promise<Picture | null> => {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    size += value.byteLength;

    if (size > maxPictureBytes) {
      await reader.cancel();

      return null;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = pictureFormat(bytes);

  return contentType ? { bytes, contentType } : null;
};

/**
 * The picture a sign-in reports: `none` when the provider says there is none, `null`
 * when it could not be read. A failed read keeps the current picture.
 */
export type PictureResult = Picture | "none" | null;

const pictureRequest = async (url: string, init: RequestInit): Promise<PictureResult> => {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });

    if (response.status === 404) {
      await response.body?.cancel();

      return "none";
    }

    if (!response.ok) {
      await response.body?.cancel();

      return null;
    }

    return await readPicture(response);
  } catch {
    return null;
  }
};

// Google and company OIDC providers name a picture URL. It must be HTTPS on a public host.
export const pictureUrl = z.url({ protocol: /^https$/ }).max(2048);

export const fetchPictureUrl = async (url: z.infer<typeof pictureUrl>): Promise<PictureResult> => {
  const parsed = new URL(url);

  if (parsed.username || parsed.password) return null;

  try {
    if (!(await isPublicOrigin(parsed.origin))) return null;
  } catch {
    return null;
  }

  return pictureRequest(parsed.href, { headers: { accept: "image/*" } });
};

// Microsoft has no picture URL. Graph returns the signed-in user's photo with `User.Read`.
export const fetchGraphPicture = (accessToken: string) =>
  pictureRequest("https://graph.microsoft.com/v1.0/me/photos/120x120/$value", {
    headers: { authorization: `Bearer ${accessToken}` },
  });

export const pictureVersion = async (picture: Picture) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", picture.bytes)).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
