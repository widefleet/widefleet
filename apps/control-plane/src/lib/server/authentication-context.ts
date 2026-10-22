import { organizationIdentifier } from "@platform/contracts";

// The login authority is independent of the organization selected in the UI.
// A company identity provider can authenticate only for its own organization.
export const authenticationReference = (userId: string, organizationId: string | null) =>
  organizationId === null ? `user:${userId}` : `organization:${organizationId}`;

export const readAuthenticationReference = (userId: string, reference: string | undefined) => {
  if (reference === `user:${userId}`) return { organizationId: null };

  if (!reference?.startsWith("organization:")) return null;
  const organizationId = organizationIdentifier.safeParse(reference.slice("organization:".length));

  return organizationId.success ? { organizationId: organizationId.data } : null;
};
