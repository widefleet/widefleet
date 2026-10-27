import { companyProvider, organizationIdentifier } from "@platform/contracts";
import { base64url } from "jose";
import { z } from "zod";

const hostname = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

export const authConfiguration = z
  .strictObject({
    organizationId: organizationIdentifier,
    provider: companyProvider,
    scopes: z.array(z.string()).optional(),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(16_384),
    cookieSecret: z
      .string()
      .refine(
        (value) =>
          /^[A-Za-z0-9_-]{43}$/.test(value) && base64url.encode(base64url.decode(value)) === value,
        "Use a base64url-encoded 32-byte cookie key",
      ),
    domain: hostname,
    redirectUrl: z.url(),
  })
  .superRefine((configuration, context) => {
    if (!z.url().safeParse(configuration.redirectUrl).success) return;
    const url = new URL(configuration.redirectUrl);

    if (
      url.protocol !== "https:" ||
      url.hostname !== `auth.${configuration.domain}` ||
      url.pathname !== `/oauth2/${configuration.organizationId}/callback` ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      context.addIssue({
        code: "custom",
        path: ["redirectUrl"],
        message:
          "Use the organization's HTTPS callback at auth.APP_DOMAIN/oauth2/ORGANIZATION/callback",
      });
  });

export type AuthConfiguration = z.infer<typeof authConfiguration>;

export const sessionVersion = async (configuration: AuthConfiguration) => {
  // Changing the identity source must invalidate identities issued by the old
  // provider. Rotating only its client secret does not change existing users.
  const source = JSON.stringify({
    sessionFormat: 2,
    organizationId: configuration.organizationId,
    provider: configuration.provider,
    clientId: configuration.clientId,
    redirectUrl: configuration.redirectUrl,
    domain: configuration.domain,
  });

  return base64url.encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))),
  );
};
