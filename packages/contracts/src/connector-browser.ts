// A 53-character label cannot collide with a self-hosted app slug (max 48).
// Hosted app names contain a separator before their organization suffix.
export const connectorBrowserOrigin = async (
  organizationId: string,
  name: string,
  domain: string,
  port = 443,
) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([organizationId, name])),
    ),
  );

  const label = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `https://c${label.slice(0, 52)}.${domain}${port === 443 ? "" : `:${port}`}`;
};

export const connectorBrowserUrl = (origin: string, entrypoint: string) =>
  new URL(entrypoint === "default" ? "/" : `/_widefleet/entrypoints/${entrypoint}/`, origin).href;
