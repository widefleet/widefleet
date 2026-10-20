// This context is resolved from authenticated membership, never accepted as request input.
// Background commands retain it so opening a fresh database cannot widen app access.
export { applicationContext } from "@platform/contracts";

// Candidates already belong to the authenticated user. Admission may only narrow them.
export type OrganizationAccess = {
  filterOrganizations: (candidates: readonly { id: string }[]) => Promise<string[]>;
  defaultOrganizationId?: string;
};
