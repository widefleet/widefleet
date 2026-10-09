import { form, query } from "$app/server";
import { identifier } from "@platform/contracts";
import { z } from "zod";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getAgents = query(async () => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.agents.list(principal));
});

export const disableAgent = form(
  z.object({ agentId: identifier, id: identifier.optional() }),
  async ({ agentId }) => {
    const { runtime, principal } = await remoteContext(true);
    formValue(await runtime.agents.disable(principal, agentId));
    await getAgents().refresh();

    return { disabled: true };
  },
);
