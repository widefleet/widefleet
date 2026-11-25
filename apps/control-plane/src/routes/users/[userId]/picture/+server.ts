import { error } from "@sveltejs/kit";
import { sessionSignIn } from "#server/identity";
import { queryValue } from "#server/remote-support";
import { getRuntime } from "#server/runtime";
import { readUserPicture, tokenViewer } from "#server/user-pictures";
import type { RequestHandler } from "./$types";

// This route checks access itself, outside the `(auth)` pages: the app proxy sends only an
// access token, and those pages send requests without a browser session to sign-in.
// Pictures are copies of what sign-in providers report. The bytes were checked to be PNG,
// JPEG, GIF or WebP; they are never sniffed, scripted or embedded on another site.
export const GET: RequestHandler = async ({ params, locals, request }) => {
  const { user, session } = locals;
  const runtime = await getRuntime();

  const viewer =
    user && session
      ? {
          id: user.id,
          organizations: queryValue(
            await runtime.identity.listOrganizations(sessionSignIn(user, session)),
          ),
        }
      : request.headers.get("authorization")?.startsWith("Bearer ")
        ? await tokenViewer(runtime.auth, request.headers)
        : null;

  if (!viewer) error(401, "Sign in to see this picture.");

  const picture = await readUserPicture(runtime.database.db, viewer, params.userId);

  if (!picture) error(404, "Picture not found");
  const etag = `"${picture.version}"`;

  // Each check repeats the authorization above, so a person removed from an organization
  // stops seeing its members' pictures when their browser next asks.
  const headers = {
    etag,
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "same-origin",
  };

  if (request.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers });

  return new Response(Buffer.from(picture.bytes), {
    headers: { ...headers, "content-type": picture.contentType },
  });
};
