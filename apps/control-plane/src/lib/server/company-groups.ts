import { z } from "zod";

// Only use Microsoft's fixed endpoint, never URLs supplied in token overage claims.
// Delegated User.Read can check the signed-in user's relevant memberships.
export const checkCompanyGroups = async (
  token: string,
  candidates: string[],
  request: typeof fetch = fetch,
) => {
  const groups = [];

  for (let offset = 0; offset < candidates.length; offset += 20) {
    const batch = candidates.slice(offset, offset + 20);

    const response = await request("https://graph.microsoft.com/v1.0/me/checkMemberGroups", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ groupIds: batch }),
    });

    if (!response.ok) throw new Error("Company group memberships could not be verified");
    const result = z.object({ value: z.array(z.uuid()).max(20) }).parse(await response.json());

    for (const group of result.value) {
      if (!batch.includes(group)) throw new Error("Unexpected company group membership");
      groups.push(group);
    }
  }

  return [...new Set(groups)];
};
