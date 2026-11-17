import { base64url } from "jose";

export const connectionOnboardingCookie = async (userId: string, organizationId: string) => {
  const pair = new TextEncoder().encode(JSON.stringify([userId, organizationId]));
  const digest = await crypto.subtle.digest("SHA-256", pair);

  return `widefleet_connections_seen_${base64url.encode(new Uint8Array(digest))}`;
};
