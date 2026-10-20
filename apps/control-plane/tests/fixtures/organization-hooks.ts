import type { Handle } from "@sveltejs/kit/hooks";
import { createIdentityService } from "../../src/lib/server/identity.ts";
import { getRuntime } from "../../src/lib/server/runtime-node.ts";
import { createRequestRuntime } from "../../src/lib/server/runtime-services.ts";

// This test-only entrypoint admits fixture memberships through the public extension
// contract. The standard Node entrypoint retains its default-fleet policy.
export const handle: Handle = ({ event, resolve }) => {
  event.locals.runtime = createRequestRuntime(async () => {
    const runtime = await getRuntime();

    return {
      ...runtime,
      identity: createIdentityService(runtime.auth, runtime.database.db, runtime.configuration, {
        filterFleets: async (candidates) => candidates.map((candidate) => candidate.id),
      }),
    };
  });

  return resolve(event);
};
