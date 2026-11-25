import type { companyProvider } from "@platform/contracts";
import type { JWTPayload } from "jose";
import { z } from "zod";
import { issuer } from "./identity.ts";

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

export const pictureRequest = async (url: string, init: RequestInit): Promise<PictureResult> => {
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

// A picture URL as a provider reports it in a claim.
export const pictureUrl = z.url().max(2048);

/**
 * Only the provider's own origin, which receives its access token like its other endpoints,
 * and Google's account picture host are asked for a picture. Other hosts are not contacted.
 */
export const fetchPictureUrl = (
  url: URL,
  providerOrigin: string,
  accessToken: string | undefined,
): Promise<PictureResult> => {
  if (url.username || url.password) return Promise.resolve(null);

  if (url.origin === providerOrigin)
    return accessToken
      ? pictureRequest(url.href, {
          headers: { accept: "image/*", authorization: `Bearer ${accessToken}` },
        })
      : Promise.resolve(null);

  if (url.protocol === "https:" && url.hostname.endsWith(".googleusercontent.com"))
    return pictureRequest(url.href, { headers: { accept: "image/*" } });

  return Promise.resolve(null);
};

// Sign-in claims that may name a picture.
export const pictureClaims = z.looseObject({ picture: z.unknown().optional() });

export type PictureClaims = z.infer<typeof pictureClaims>;

// Google names Workspace accounts' pictures only in its user info, never in their ID tokens.
export const googleUserInfo = "https://openidconnect.googleapis.com/v1/userinfo";

/** The provider's user info with the sign-in's access token; `null` when it cannot be read. */
export const fetchUserInfoClaims = async (endpoint: string, accessToken: string) => {
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      await response.body?.cancel();

      return null;
    }

    const claims = pictureClaims.safeParse(await response.json());

    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
};

/**
 * The picture the sign-in's claims name. Claims that name none mean the person has none, for
 * example after they removed it; unreadable claims keep the current copy.
 */
export const claimedPicture = (
  claims: PictureClaims | null,
  providerOrigin: string,
  accessToken: string | undefined,
): Promise<PictureResult> => {
  if (!claims) return Promise.resolve(null);

  if (claims.picture === undefined || claims.picture === null) return Promise.resolve("none");
  const url = pictureUrl.safeParse(claims.picture);

  return url.success
    ? fetchPictureUrl(new URL(url.data), providerOrigin, accessToken)
    : Promise.resolve(null);
};

// A copy lives as long as its owner keeps signing in to the organization's apps.
const pictureLifetime = 30 * 24 * 60 * 60;

// Sign-in and session renewal ask the provider again at most once a day.
const pictureRecheck = 24 * 60 * 60 * 1000;

// An entry without a picture records only when the provider was last asked.
const pictureMetadata = z.object({
  contentType: z.string().nullable(),
  version: z.string().nullable(),
  checkedAt: z.number(),
});

// The parts of a KV namespace the store uses.
export interface PictureStorage {
  getWithMetadata(
    key: string,
    type: "arrayBuffer",
  ): Promise<{ value: ArrayBuffer | null; metadata: unknown }>;
  put(
    key: string,
    value: Uint8Array<ArrayBuffer>,
    options: { expirationTtl: number; metadata: z.infer<typeof pictureMetadata> },
  ): Promise<void>;
}

const refreshing = new Map<string, Promise<string | undefined>>();

/** Copies of the pictures that people of one organization's sign-in report. */
export const pictureStore = (storage: PictureStorage, organizationId: string, issuer: string) => {
  const key = async (subject: string) => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issuer)),
    );

    const issuerId = Array.from(digest.slice(0, 8), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    return `${organizationId}/${issuerId}/${subject}`;
  };

  const entry = async (subject: string) => {
    const stored = await storage.getWithMetadata(await key(subject), "arrayBuffer");
    const metadata = pictureMetadata.safeParse(stored.metadata);

    return stored.value && metadata.success
      ? { bytes: new Uint8Array(stored.value), ...metadata.data }
      : null;
  };

  const write = async (subject: string, picture: Picture | null, version: string | null) =>
    storage.put(await key(subject), picture?.bytes ?? new Uint8Array(), {
      expirationTtl: pictureLifetime,
      metadata: { contentType: picture?.contentType ?? null, version, checkedAt: Date.now() },
    });

  return {
    read: async (subject: string) => {
      const stored = await entry(subject);

      return stored?.version && stored.contentType
        ? { bytes: stored.bytes, contentType: stored.contentType, version: stored.version }
        : null;
    },
    /**
     * The version of the subject's copy, after asking the provider when it is due. Every
     * answer, including no picture or a failure, waits a day before the provider is asked again.
     */
    refresh: async (subject: string, fetchPicture: () => Promise<PictureResult>) => {
      const id = await key(subject);
      const running = refreshing.get(id);

      if (running) return running;

      const refreshed = (async () => {
        const current = await entry(subject);
        const kept = current?.version ?? undefined;

        if (current && Date.now() - current.checkedAt < pictureRecheck) return kept;
        const picture = await fetchPicture();

        // A failed read keeps the current copy.
        const [bytes, version] =
          picture === null
            ? [
                current?.version && current.contentType
                  ? { bytes: current.bytes, contentType: current.contentType }
                  : null,
                current?.version ?? null,
              ]
            : picture === "none"
              ? [null, null]
              : [picture, await pictureVersion(picture)];

        try {
          await write(subject, bytes, version);
        } catch {
          // Another isolate may write the same key at the same moment. The stored entry
          // still answers until the next check.
          return kept;
        }

        return version ?? undefined;
      })();

      // Parallel renewals of one session in this isolate share the provider request.
      refreshing.set(id, refreshed);

      try {
        return await refreshed;
      } finally {
        refreshing.delete(id);
      }
    },
  };
};

export type PictureStore = ReturnType<typeof pictureStore>;

// A generic OIDC provider's user info endpoint, from the discovery document sign-in uses;
// `null` when discovery fails, `undefined` when the provider has none.
const discoveredUserInfo = async (issuerUrl: string) => {
  try {
    const response = await fetch(`${issuerUrl}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      await response.body?.cancel();

      return null;
    }

    const discovered = z
      .object({ userinfo_endpoint: z.url().optional() })
      .safeParse(await response.json());

    return discovered.success ? discovered.data.userinfo_endpoint : null;
  } catch {
    return null;
  }
};

/**
 * The picture a company sign-in reports. Entra has no picture URL; Graph returns the photo.
 * Other providers name one in the ID token or, like Google for Workspace accounts, only in
 * their user info.
 */
export const providerPicture = async (
  provider: z.infer<typeof companyProvider>,
  claims: JWTPayload,
  accessToken: string | undefined,
): Promise<PictureResult> => {
  if (provider.type === "entra") return accessToken ? fetchGraphPicture(accessToken) : null;

  const fromIdToken = pictureClaims.safeParse(claims);

  const userInfo =
    fromIdToken.success && fromIdToken.data.picture === undefined && accessToken
      ? provider.type === "google"
        ? googleUserInfo
        : await discoveredUserInfo(issuer(provider))
      : undefined;

  // A failed lookup keeps the copy; only a provider without user info falls back to the ID
  // token, which then names no picture.
  return claimedPicture(
    userInfo === null
      ? null
      : userInfo && accessToken
        ? await fetchUserInfoClaims(userInfo, accessToken)
        : fromIdToken.success
          ? fromIdToken.data
          : null,
    new URL(issuer(provider)).origin,
    accessToken,
  );
};
