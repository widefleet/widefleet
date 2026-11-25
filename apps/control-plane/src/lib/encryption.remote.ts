import { form, query } from "$app/server";
import { organizationSelection } from "@platform/contracts";
import { formValue, queryValue, remoteContext } from "#server/remote-support";

export const getSecretEncryption = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return queryValue(await runtime.secretEncryption.status(principal));
});

export const reencryptSecrets = form(organizationSelection, async ({ organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });
  const result = formValue(await runtime.secretEncryption.reencrypt(principal));

  // The result already counts what remains, so the page needs no second read.
  getSecretEncryption({ organizationId }).set(result.status);

  return result;
});
