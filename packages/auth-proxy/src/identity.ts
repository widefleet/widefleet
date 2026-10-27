import {
  accessContext,
  appAccessGroup,
  companyProvider,
  googleDirectoryCredentials,
} from "@platform/contracts";
import { APIError } from "better-auth/api";
import { decodeJwt } from "jose";
import { z } from "zod";
import { createGoogleDirectory } from "./google-directory.ts";

const claim = z
  .string()
  .max(4096)
  .refine((value) =>
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);

      return code >= 32 && code !== 127;
    }),
  );

// Preserve the provider's exact group IDs; trimming a claim could turn one
// group into a different group that is allowed to access an app.
const groups = z.array(
  z
    .string()
    .refine((value) => value === value.trim())
    .pipe(appAccessGroup),
);

export const proxyIdentity = accessContext.extend({
  id: claim.min(1).refine((value) => value === value.trim()),
  name: claim,
  email: z.email(),
  groups,
});

export const issuer = (provider: z.infer<typeof companyProvider>) =>
  provider.type === "entra"
    ? `${provider.authority}/${provider.tenantId}/v2.0`
    : provider.issuer.replace(/\/$/, "");

const graphGroups = async (accessToken: string) => {
  const collected = new Set<string>();
  const visited = new Set<string>();
  let next: string | undefined = "https://graph.microsoft.com/v1.0/me/transitiveMemberOf";

  while (next) {
    const url = new URL(next);

    // Never forward the access token to a claim-supplied endpoint or an arbitrary
    // pagination URL. Entra overage claims only signal that Graph is needed.
    if (
      url.origin !== "https://graph.microsoft.com" ||
      url.pathname !== "/v1.0/me/transitiveMemberOf" ||
      url.username ||
      url.password ||
      url.hash ||
      visited.has(url.href) ||
      visited.size >= 100
    )
      throw new Error("Invalid group pagination");

    visited.add(url.href);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok)
      throw new APIError(
        "SERVICE_UNAVAILABLE",
        { message: "Unable to resolve company groups" },
        response.status === 429
          ? { "Retry-After": response.headers.get("retry-after") ?? "1" }
          : undefined,
      );

    const page = z
      .object({
        value: z.array(z.object({ id: z.uuid() })),
        "@odata.nextLink": z.url().optional(),
      })
      .parse(await response.json());

    for (const group of page.value) collected.add(group.id);
    next = page["@odata.nextLink"];
  }

  return [...collected];
};

export const providerIdentity = async (
  provider: z.infer<typeof companyProvider>,
  idToken: string,
  accessToken: string | undefined,
  organizationId: string,
  directory?: z.infer<typeof googleDirectoryCredentials>,
) => {
  // Called only by Better Auth's getUserInfo, after its signature, issuer,
  // audience and nonce verification. This maps already verified claims.
  const claims = decodeJwt(idToken);

  // Better Auth checks the exact published issuer. This additional comparison
  // tolerates a trailing slash in the saved OIDC URL without changing that check.
  const tokenIssuer = provider.type === "oidc" ? claims.iss?.replace(/\/$/, "") : claims.iss;

  if (tokenIssuer !== issuer(provider) || claims["email_verified"] === false)
    throw new Error("The company identity is not trusted");

  if (
    provider.type === "google" &&
    (claims["hd"] !== provider.domain || claims["email_verified"] !== true)
  )
    throw new APIError("UNAUTHORIZED", {
      message: "The identity is not a verified Workspace account in this domain",
    });

  if (
    provider.type === "oidc" &&
    provider.organizationClaim &&
    claims[provider.organizationClaim] !== organizationId
  )
    throw new Error("The identity belongs to a different organization");

  const subject =
    provider.type === "entra"
      ? z.object({ oid: z.uuid(), tid: z.literal(provider.tenantId) }).parse(claims).oid
      : z.string().min(1).parse(claims.sub);

  const groupClaim = provider.type === "oidc" ? provider.groupsClaim : "groups";

  if (provider.type === "entra" && !accessToken)
    throw new Error("Company group lookup requires an access token");

  const membership =
    provider.type === "entra" && accessToken
      ? await graphGroups(accessToken)
      : provider.type === "google"
        ? await createGoogleDirectory(googleDirectoryCredentials.parse(directory)).memberships(
            subject,
          )
        : groups.parse(claims[groupClaim] ?? []);

  const identity = proxyIdentity.parse({
    id: subject,
    name: claims[provider.type === "oidc" ? provider.nameClaim : "name"] ?? "",
    email: claims[provider.type === "oidc" ? provider.emailClaim : "email"],
    groups: membership,
  });

  return { claims, identity };
};
