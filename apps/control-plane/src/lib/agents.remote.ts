import { form, query } from "$app/server";
import { identifier, organizationSelection } from "@platform/contracts";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getAgents = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  // The API lists agents for app creators too; this page manages them, so it is for administrators.
  if (!principal.admin) error(403, "This page is only available to administrators.");

  return queryValue(await runtime.agents.list(principal));
});

export const disableAgent = form(
  z.object({ ...organizationSelection.shape, agentId: identifier, id: identifier.optional() }),
  async ({ agentId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.agents.disable(principal, agentId));
    await getAgents({ organizationId }).refresh();

    return { disabled: true };
  },
);
