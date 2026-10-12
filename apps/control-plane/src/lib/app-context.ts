import { createContext } from "svelte";
import type { getAppDetails } from "#lib/apps.remote";

export const [getAppContext, setAppContext] = createContext<{
  readonly data: Awaited<ReturnType<typeof getAppDetails>>;
  readonly search: string;
  readonly requestId: string;
  readonly rollbackPending: boolean;
  submitRollback: (submission: { submit: () => Promise<boolean> }) => Promise<void>;
}>();
