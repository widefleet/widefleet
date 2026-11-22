import { command, query, requested } from "$app/server";
import {
  joinDomainInput,
  organizationCreationRestriction,
  organizationSelection,
} from "@platform/contracts";
import { remoteContext, commandContext, remoteOperation } from "#server/remote-support";

// Null when the installation has no self-service organizations to join.
export const getDomainAccess = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  if (!runtime.domainAccess.enabled) return null;

  return remoteOperation(() => runtime.domainAccess.read(principal));
});

const refresh = () => requested(getDomainAccess, 1).refreshAll();

export const addJoinDomain = command(
  joinDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.domainAccess.addJoinDomain(principal, domain));
    await refresh();
  },
);

export const removeJoinDomain = command(
  joinDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.domainAccess.removeJoinDomain(principal, domain));
    await refresh();
  },
);

export const restrictOrganizationCreation = command(
  organizationCreationRestriction.extend(organizationSelection.shape),
  async ({ organizationId, restricted }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() =>
      runtime.domainAccess.restrictOrganizationCreation(principal, restricted),
    );
    await refresh();
  },
);
