import { command, getRequestEvent, query } from "$app/server";
import { error } from "@sveltejs/kit";
import { settingsInput, settingsUpdate, setupOwner } from "@platform/contracts";
import { z } from "zod";
import { createInstallationOwner } from "#server/installation-store";
import { remoteContext, remoteOperation } from "#server/remote-support";
import { getRuntime } from "#server/runtime";
import { readSettingsAccount } from "#server/settings-account";

export const getSettings = query(async () => {
  const { runtime, principal, request } = await remoteContext();

  return remoteOperation(() => readSettingsAccount(runtime, principal, request.headers));
});

export const planSettings = command(settingsInput, async (input) => {
  const { runtime, principal } = await remoteContext(true);

  return remoteOperation(() => runtime.settings.plan(principal, input));
});

export const updateSettings = command(settingsUpdate, async (input) => {
  const { runtime, principal } = await remoteContext(true);
  await remoteOperation(() => runtime.settings.update(principal, input, true));
  await getSettings().refresh();
});

export const setExternalManagement = command(
  z.object({ enabled: z.boolean() }),
  async ({ enabled }) => {
    const { runtime, principal } = await remoteContext(true);
    await remoteOperation(() => runtime.settings.setExternalManagement(principal, enabled));
    await getSettings().refresh();
  },
);

export const completeSetup = command(async () => {
  const { runtime, principal, request } = await remoteContext(true);
  await remoteOperation(() => runtime.settings.complete(principal, runtime.auth, request.headers));
  await getSettings().refresh();
});

export const createOwner = command(setupOwner, async (input) => {
  const { request } = getRequestEvent();
  const runtime = await getRuntime();

  if (request.headers.get("origin") !== runtime.configuration.PLATFORM_URL)
    error(403, "A same-origin setup request is required");

  return remoteOperation(() => createInstallationOwner(runtime.database.db, input));
});
