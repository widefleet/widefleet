import { form, query } from "$app/server";
import { identifier, organizationSelection } from "@platform/contracts";
import { z } from "zod";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getAgents = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

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
