import { command, getRequestEvent, query } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
import {
  settingsInput,
  settingsUpdate,
  setupOwner,
  organizationSelection,
} from "@platform/contracts";
import { z } from "zod";
import { remoteContext, remoteOperation } from "#server/remote-support";
import { getRuntime } from "#server/runtime";
import { readSettingsAccount } from "#server/settings-account";

export const getSettings = query(async () => {
  const { runtime, principal, request } = await remoteContext();

  return remoteOperation(() => readSettingsAccount(runtime, principal, request.headers));
});

export const planSettings = command(
  settingsInput.extend(organizationSelection.shape),
  async ({ organizationId, ...input }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    return remoteOperation(() => runtime.settings.plan(principal, input));
  },
);

export const updateSettings = command(
  settingsUpdate.extend(organizationSelection.shape),
  async ({ organizationId, ...input }) => {
    const { runtime, principal, request } = await remoteContext({ organizationId });
    await remoteOperation(() =>
      runtime.settings.update(principal, input, true, {
        auth: runtime.auth,
        headers: request.headers,
      }),
    );

    if (!(await runtime.auth.api.getSession({ headers: request.headers })))
      redirect(303, "/sign-in?next=/settings");
    await getSettings().refresh();
  },
);

export const setExternalManagement = command(
  organizationSelection.extend({ enabled: z.boolean() }),
  async ({ enabled, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    await remoteOperation(() => runtime.settings.setExternalManagement(principal, enabled));
    await getSettings().refresh();
  },
);

export const completeSetup = command(organizationSelection, async (input) => {
  const { runtime, principal, request } = await remoteContext(input);
  await remoteOperation(() => runtime.settings.complete(principal, runtime.auth, request.headers));
  await getSettings().refresh();
});

export const createOwner = command(setupOwner, async (input) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();

  if (request.headers.get("origin") !== runtime.configuration.PLATFORM_URL)
    error(403, "A same-origin setup request is required");

  return remoteOperation(() => runtime.settings.createOwner(input));
});

export const requestDomainVerification = command(organizationSelection, async (input) => {
  const { runtime, principal, request } = await remoteContext(input);

  return remoteOperation(() =>
    runtime.settings.domainVerification(principal, runtime.auth, request.headers),
  );
});

export const verifyCompanyDomain = command(organizationSelection, async (input) => {
  const { runtime, principal, request } = await remoteContext(input);

  return remoteOperation(() =>
    runtime.settings.verifyDomain(principal, runtime.auth, request.headers),
  );
});

export const activateCompanySso = command(organizationSelection, async (input) => {
  const { runtime, principal } = await remoteContext(input);
  await remoteOperation(() => runtime.settings.activateSso(principal));
});
