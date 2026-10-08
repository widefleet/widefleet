import { Result } from "better-result";
import { decodeJwt } from "jose";
import { z } from "zod";
import { appAccessGroup, companyProvider } from "@platform/contracts";
import { providerIssuer } from "./company-identity.ts";

// Better Auth verifies the provider ID token before storing this linked account.
// Only that persisted token supplies authorization claims; request headers and
// editable user profile fields never do. Expiry is the issuer's own deadline.
export const readCompanyClaims = (
  provider: z.infer<typeof companyProvider>,
  account: { accountId: string; idToken: string | null },
) => {
  if (!account.idToken) return undefined;
  const token = account.idToken;
  const result = Result.try(() => decodeJwt(token));

  if (result.isErr()) return undefined;
  const decoded = result.value;

  const claims = z
    .object({ iss: z.literal(providerIssuer(provider)), exp: z.number(), sub: z.string() })
    .passthrough()
    .safeParse(decoded);

  if (!claims.success) return undefined;

  const subject = appAccessGroup.safeParse(
    provider.type === "entra" ? decoded["oid"] : decoded[provider.subjectClaim],
  );

  if (!subject.success || subject.data !== account.accountId) return undefined;

  if (provider.type === "entra" && decoded["tid"] !== provider.tenantId) return undefined;
  const expiresAt = claims.data.exp * 1000;

  const groups = z
    .array(appAccessGroup)
    .max(1000)
    .safeParse(decoded[provider.type === "entra" ? "groups" : provider.groupsClaim] ?? []);

  return {
    provider: providerIssuer(provider),
    subject: subject.data,
    groups: groups.success && expiresAt > Date.now() ? [...new Set(groups.data)] : [],
    groupsExpired: expiresAt <= Date.now(),
    expiresAt,
    overage:
      provider.type === "entra" &&
      (decoded["hasgroups"] === true ||
        z.object({ groups: z.string() }).safeParse(decoded["_claim_names"]).success),
  };
};
