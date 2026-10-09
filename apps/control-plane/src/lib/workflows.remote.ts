import { command, query } from "$app/server";
import { appPath, identifier, workflowRequest } from "@platform/contracts";
import { queryValue, remoteContext } from "#server/remote-support";

export const getWorkflows = query(appPath, async ({ appId }) => {
  const { runtime, principal } = await remoteContext();

  return queryValue(await runtime.workflows.definitions(principal, appId));
});

export const manageWorkflow = command(
  appPath.extend({ requestId: identifier, request: workflowRequest }),
  async ({ appId, requestId, request }) => {
    const { runtime, principal } = await remoteContext(
      request.action !== "list" && request.action !== "status",
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
