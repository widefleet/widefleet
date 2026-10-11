import { z } from "zod";

// Delegated User.Read exposes IDs and types for the signed-in user's transitive
// memberships. Work depends on that person, never the installation's app count.
export const readCompanyGroups = async (
  token: string,
  subject: string,
  request: typeof fetch = fetch,
) => {
  const groups = new Set<string>();
  const signal = AbortSignal.timeout(10_000);

  let next: string | undefined =
    "https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id&$top=999";

  for (let page = 0; next && page < 20; page++) {
    signal.throwIfAborted();
    const url = new URL(next);

    if (
      url.origin !== "https://graph.microsoft.com" ||
      url.username ||
      url.password ||
      ![
        "/v1.0/me/transitiveMemberOf",
        `/v1.0/users/${encodeURIComponent(subject)}/transitiveMemberOf`,
      ].includes(url.pathname)
    )
      throw new Error("Unexpected company membership page");

    const response = await request(url, {
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${token}` },
    });

    if (!response.ok) throw new Error("Company group memberships could not be verified");

    const result = z
      .object({
        value: z.array(z.object({ id: z.uuid(), "@odata.type": z.string() })).max(999),
        "@odata.nextLink": z.url().optional(),
      })
      .parse(await response.json());

    for (const entry of result.value)
      if (entry["@odata.type"] === "#microsoft.graph.group") groups.add(entry.id);

    next = result["@odata.nextLink"];
  }

  // Never authorize from a partial membership list or extend the total deadline per page.
  signal.throwIfAborted();

  if (next) throw new Error("Company group memberships exceed the lookup limit");

  return [...groups];
};
