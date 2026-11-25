import { command, query } from "$app/server";
import { organizationSelection } from "@platform/contracts";
import { z } from "zod";
import { commandContext, queryValue, remoteContext } from "#server/remote-support";

export const getSecretEncryption = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return queryValue(await runtime.secretEncryption.status(principal));
});

// The page repeats this until the cursor is null, as the CLI does with the API.
export const reencryptSecretBatch = command(
  z.object({ ...organizationSelection.shape, cursor: z.string().min(1).nullable() }),
  async ({ organizationId, cursor }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    const batch = queryValue(await runtime.secretEncryption.reencrypt(principal, cursor));

    // The last batch returns the updated counts in the same response.
    if (batch.cursor === null) await getSecretEncryption({ organizationId }).refresh();

    return batch;
  },
);
