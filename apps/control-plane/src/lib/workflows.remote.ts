import { command, query } from "$app/server";
import { appPath, identifier, workflowRequest, organizationSelection } from "@platform/contracts";
import { commandContext, queryValue, remoteContext } from "#server/remote-support";

const appTarget = appPath.extend(organizationSelection.shape);

export const getWorkflows = query(appTarget, async ({ appId, organizationId }) => {
  const { runtime, principal } = await remoteContext({ organizationId });

  return queryValue(await runtime.workflows.definitions(principal, appId));
});

export const manageWorkflow = command(
  appTarget.extend({
    requestId: identifier,
    request: workflowRequest,
  }),
  async ({ appId, requestId, request, organizationId }) => {
    const { runtime, principal } = await commandContext({ organizationId });

    return queryValue(await runtime.workflows.create(principal, appId, requestId, request));
  },
);

export const getWorkflowOperation = query(
  appTarget.extend({ jobId: identifier }),
  async ({ appId, jobId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    return queryValue(await runtime.workflows.read(principal, appId, jobId));
  },
);
