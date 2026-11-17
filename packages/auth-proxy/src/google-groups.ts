import { APIError } from "better-auth/api";
import { z } from "zod";

const page = z.object({
  memberships: z.array(z.object({ groupKey: z.object({ id: z.email() }) })).default([]),
  nextPageToken: z.string().optional(),
});

export const googleGroups = async (accessToken: string, email: string) => {
  const groups = new Set<string>();
  const visited = new Set<string>();
  let next = "";

  do {
    if (visited.has(next) || visited.size >= 100) throw new Error("Invalid group pagination");
    visited.add(next);

    // Query only the verified user's direct memberships. Cloud Identity omits
    // groups whose membership list that user cannot view.
    const url = new URL(
      "https://cloudidentity.googleapis.com/v1/groups/-/memberships:searchDirectGroups",
    );

    url.search = new URLSearchParams({
      query: `member_key_id == ${JSON.stringify(email)} && 'cloudidentity.googleapis.com/groups.discussion_forum' in labels`,
      pageSize: "1000",
      pageToken: next,
    }).toString();

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok)
      throw new APIError(
        "SERVICE_UNAVAILABLE",
        { message: "Unable to resolve Google Workspace groups" },
        response.status === 429
          ? { "Retry-After": response.headers.get("retry-after") ?? "1" }
          : undefined,
      );

    const result = page.parse(await response.json());

    for (const membership of result.memberships) groups.add(membership.groupKey.id);
    next = result.nextPageToken ?? "";
  } while (next);

  return [...groups];
};
