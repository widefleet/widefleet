import { createContext } from "svelte";

export const [getWorkspaceContext, setWorkspaceContext] = createContext<{
  readonly organizationId: string;
}>();
