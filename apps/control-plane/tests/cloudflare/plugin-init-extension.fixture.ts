import type { RuntimeExtensionContext } from "../../src/lib/server/runtime-extension.ts";
import { readInstallation } from "../../src/lib/server/installation-store.ts";

// Like the hosted extension, an authentication plugin reads the database while Better Auth
// initializes.
export const createRuntimeExtension = ({ database }: RuntimeExtensionContext) => ({
  authentication: {
    plugins: [
      {
        id: "fixture-initialization-read",
        init: async () => {
          await readInstallation(database);
        },
      },
    ],
  },
});
