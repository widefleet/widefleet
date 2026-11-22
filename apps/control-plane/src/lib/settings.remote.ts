import { command, getRequestEvent, query } from "$app/server";
import { error } from "@sveltejs/kit";
import {
  settingsInput,
  settingsUpdate,
  setupOwner,
  organizationSelection,
  ssoDomainInput,
} from "@platform/contracts";
import { z } from "zod";
import { commandContext, remoteContext, remoteOperation } from "#server/remote-support";
import { getRuntime } from "#server/runtime";
import { readSettingsAccount } from "#server/settings-account";

export const getSettings = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return remoteOperation(() =>
    readSettingsAccount(runtime, principal, getRequestEvent().locals.session),
  );
});

export const planSettings = command(
  settingsInput.extend(organizationSelection.shape),
  async ({ organizationId, ...input }) => {
    const { runtime, principal } = await commandContext({ organizationId });

    return remoteOperation(() => runtime.settings.plan(principal, input));
  },
);

export const updateSettings = command(
  settingsUpdate.extend(organizationSelection.shape),
  async ({ organizationId, ...input }) => {
    const { runtime, principal, request } = await commandContext({ organizationId });
    await remoteOperation(() =>
      runtime.settings.update(principal, input, true, {
        auth: runtime.auth,
        headers: request.headers,
      }),
    );

    if (!(await runtime.auth.api.getSession({ headers: request.headers })))
      return { signedOut: true };
    await getSettings({ organizationId }).refresh();

    return { signedOut: false };
  },
);

export const setExternalManagement = command(
  organizationSelection.extend({ enabled: z.boolean() }),
  async ({ enabled, organizationId }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.setExternalManagement(principal, enabled));
    await getSettings({ organizationId }).refresh();
  },
);

export const createOwner = command(setupOwner, async (input) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();

  if (request.headers.get("origin") !== runtime.configuration.PLATFORM_URL)
    error(403, "A same-origin setup request is required");

  return remoteOperation(() => runtime.settings.createOwner(input));
});

export const addCompanyDomain = command(
  ssoDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.addDomain(principal, domain, true));
    await getSettings({ organizationId }).refresh();
  },
);

export const removeCompanyDomain = command(
  ssoDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.removeDomain(principal, domain, true));
    await getSettings({ organizationId }).refresh();
  },
);

export const verifyCompanyDomain = command(
  ssoDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });

    try {
      await remoteOperation(() => runtime.settings.verifyDomain(principal, domain));
    } finally {
      await getSettings({ organizationId }).refresh();
    }
  },
);

export const activateCompanySso = command(organizationSelection, async (input) => {
  const { runtime, principal } = await commandContext(input);
  await remoteOperation(() => runtime.settings.activateSso(principal));
});
