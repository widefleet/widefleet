import { z } from "zod";
import type { RuntimeExtension } from "../../src/lib/server/runtime-extension.ts";

// This module is selected only by the local onboarding browser fixture.
export const createRuntimeExtension = () => {
  const mailbox = new URL(z.url().parse(process.env["PLATFORM_TEST_MAILBOX"]));

  if (mailbox.protocol !== "http:" || mailbox.hostname !== "127.0.0.1")
    throw new Error("The synthetic mailbox must use loopback HTTP");

  return {
    organizationAccess: {
      filterOrganizations: async (candidates) => candidates.map((candidate) => candidate.id),
    },
    sendEmail: async (message) => {
      const response = await fetch(mailbox, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });

      if (!response.ok) throw new Error("Synthetic mailbox unavailable");
    },
  } satisfies RuntimeExtension;
};
