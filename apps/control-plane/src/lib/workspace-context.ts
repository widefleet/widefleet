import { createContext } from "svelte";

export const [getWorkspaceContext, setWorkspaceContext] = createContext<{
  readonly organizationId: string;
  // Resolves a path within the organization, such as `/apps`, to its page URL.
  path: (path: string) => string;
}>();
