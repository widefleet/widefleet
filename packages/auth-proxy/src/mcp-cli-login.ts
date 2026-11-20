import { organizationIdentifier } from "@platform/contracts";
import { base64url } from "jose";
import { z } from "zod";

// Long enough to copy the command into a shell, short enough that a code left
// in a chat transcript is useless. The control plane also accepts each code once.
export const mcpCliLoginLifetime = 120_000;

export const mcpCliLogin = z.strictObject({
  purpose: z.literal("widefleet-mcp-cli-login/v1"),
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  organizationId: organizationIdentifier,
  issuer: z.url(),
  subject: z.string().min(1),
  expiresAt: z.number().int(),
});

const code = z
  .string()
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(z.string().min(32).parse(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const read = (value: string) => {
  const [payload, signature] = code.parse(value).split(".");

  return {
    payload: Uint8Array.from(base64url.decode(payload ?? "")),
    signature: Uint8Array.from(base64url.decode(signature ?? "")),
  };
};

// The MCP server holds the user's company authorization; the CLI exchanges this
// code at the control plane, which asks the edge to verify it.
export const signMcpCliLogin = async (
  secret: string,
  login: Pick<z.infer<typeof mcpCliLogin>, "organizationId" | "issuer" | "subject">,
) => {
  const value = new TextEncoder().encode(
    JSON.stringify(
      mcpCliLogin.parse({
        purpose: "widefleet-mcp-cli-login/v1",
        id: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
        ...login,
        expiresAt: Date.now() + mcpCliLoginLifetime,
      }),
    ),
  );

  const signature = await crypto.subtle.sign("HMAC", await key(secret), value);

  return `${base64url.encode(value)}.${base64url.encode(new Uint8Array(signature))}`;
};

export const verifyMcpCliLogin = async (secret: string, value: string) => {
  try {
    const { payload, signature } = read(value);

    if (!(await crypto.subtle.verify("HMAC", await key(secret), signature, payload))) return null;
    const login = mcpCliLogin.parse(JSON.parse(new TextDecoder().decode(payload)));

    return login.expiresAt > Date.now() ? login : null;
  } catch {
    return null;
  }
};

// Unverified: only selects which organization's edge channel verifies the code.
export const mcpCliLoginOrganization = (value: string) => {
  try {
    const parsed = z
      .object({ organizationId: organizationIdentifier })
      .safeParse(JSON.parse(new TextDecoder().decode(read(value).payload)));

    return parsed.success ? parsed.data.organizationId : null;
  } catch {
    return null;
  }
};
