import { command, getRequestEvent, query, requested } from "$app/server";
import { error, redirect } from "@sveltejs/kit";
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
import { workspacePath } from "#lib/workspace-path";
import { installationOrganizationId } from "#lib/organization";
import { readOrganizationSlug } from "#server/organization";

export const getSettings = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return remoteOperation(() =>
    readSettingsAccount(runtime, principal, getRequestEvent().locals.session),
  );
});

// The sign-in service reports whether it applies the saved configuration.
export const getSettingsActivation = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return remoteOperation(() => runtime.settings.activation(principal));
});

// An active connection is managed on its own page, so its setup page sends people there.
export const checkSsoSetup = query(organizationSelection, async (selection) => {
  const { runtime, principal, organization } = await remoteContext(selection);
  const view = await runtime.settings.overview(principal);

  if (view.ssoRequired)
    redirect(303, workspacePath(organization.slug, "/settings/company-sign-in"));

  return null;
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
    await Promise.all([
      getSettings({ organizationId }).refresh(),
      getSettingsActivation({ organizationId }).refresh(),
    ]);

    return { signedOut: false };
  },
);

export const setExternalManagement = command(
  organizationSelection.extend({ enabled: z.boolean() }),
  async ({ enabled, organizationId }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.setExternalManagement(principal, enabled));
    await Promise.all([
      getSettings({ organizationId }).refresh(),
      getSettingsActivation({ organizationId }).refresh(),
    ]);
  },
);

export const setBrowserWorkers = command(
  organizationSelection.extend({ enabled: z.boolean() }),
  async ({ enabled, organizationId }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.setBrowserWorkers(principal, enabled, true));
    await Promise.all([
      getSettings({ organizationId }).refresh(),
      getSettingsActivation({ organizationId }).refresh(),
    ]);
  },
);

export const setDomainSso = command(
  organizationSelection.extend({ enabled: z.boolean() }),
  async ({ enabled, organizationId }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.setDomainSso(principal, enabled, true));
    // The page requests its settings with the optimistic value.
    await requested(getSettings, 1).refreshAll();
  },
);

export const createOwner = command(setupOwner, async (input) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();

  if (request.headers.get("origin") !== runtime.configuration.PLATFORM_URL)
    error(403, "A same-origin setup request is required");

  const { activation } = await remoteOperation(() => runtime.settings.createOwner(input));

  const slug = await readOrganizationSlug(runtime.database.db, installationOrganizationId);

  // Should turning on app sign-in have failed, the administrator retries it first.
  return {
    next: workspacePath(
      slug,
      activation?.state === "active" ? "/apps" : "/settings/company-sign-in",
    ),
  };
});

export const addCompanyDomain = command(
  ssoDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.addDomain(principal, domain, true));
    await Promise.all([
      getSettings({ organizationId }).refresh(),
      getSettingsActivation({ organizationId }).refresh(),
    ]);
  },
);

export const removeCompanyDomain = command(
  ssoDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });
    await remoteOperation(() => runtime.settings.removeDomain(principal, domain, true));
    await Promise.all([
      getSettings({ organizationId }).refresh(),
      getSettingsActivation({ organizationId }).refresh(),
    ]);
  },
);

export const verifyCompanyDomain = command(
  ssoDomainInput.extend(organizationSelection.shape),
  async ({ organizationId, domain }) => {
    const { runtime, principal } = await commandContext({ organizationId });

    try {
      await remoteOperation(() => runtime.settings.verifyDomain(principal, domain));
    } finally {
      await Promise.all([
        getSettings({ organizationId }).refresh(),
        getSettingsActivation({ organizationId }).refresh(),
      ]);
    }
  },
);

export const activateCompanySso = command(organizationSelection, async (input) => {
  const { runtime, principal } = await commandContext(input);
  await remoteOperation(() => runtime.settings.activateSso(principal));
});
