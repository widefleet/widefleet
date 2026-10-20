import { command, query } from "$app/server";
import { appPath, identifier, workflowRequest, organizationSelection } from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";

export const getWorkflows = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.workflows.definitions(principal, appId));
});

export const manageWorkflow = command(
  appPath.extend({
    ...organizationSelection.shape,
    requestId: identifier,
    request: workflowRequest,
  }),
  async ({ appId, requestId, request, organizationId }) => {
    const { runtime, principal } = await remoteContext(
      request.action !== "list" && request.action !== "status" ? { organizationId } : undefined,
    );

    return queryValue(await runtime.workflows.create(principal, appId, requestId, request));
  },
);

export const getWorkflowOperation = query(
  appPath.extend({ jobId: identifier }),
  async ({ appId, jobId }) => {
    const { runtime, principal } = await remoteContext();

    return queryValue(await runtime.workflows.read(principal, appId, jobId));
  },
);
