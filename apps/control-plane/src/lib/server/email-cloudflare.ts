import type { CloudflareBindings } from "./cloudflare-config.ts";
import type { SendEmail } from "./email.ts";
import { z } from "zod";

export const createCloudflareEmail = (
  bindings: Pick<CloudflareBindings, "EMAIL" | "EMAIL_FROM">,
): SendEmail | undefined => {
  const email = bindings.EMAIL;

  if (!email && !bindings.EMAIL_FROM) return undefined;

  if (!email) throw new Error("Configure the EMAIL binding with EMAIL_FROM");
  const from = z.email().parse(bindings.EMAIL_FROM);

  return async (message) => {
    await email.send({ from, ...message });
  };
};
