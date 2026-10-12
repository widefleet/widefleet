import { createContext } from "svelte";
import type { getAppDetails } from "#lib/apps.remote";
import type { manageWorkflow } from "#lib/workflows.remote";

export const [getAppContext, setAppContext] = createContext<{
  readonly data: Awaited<ReturnType<typeof getAppDetails>>;
  readonly search: string;
  readonly requestId: string;
  readonly rollbackPending: boolean;
  readonly workflowOperations: Readonly<Record<string, Awaited<ReturnType<typeof manageWorkflow>>>>;
  rememberWorkflowOperation: (
    appId: string,
    operation: Awaited<ReturnType<typeof manageWorkflow>>,
  ) => void;
  submitRollback: (submission: { submit: () => Promise<boolean> }) => Promise<void>;
}>();
