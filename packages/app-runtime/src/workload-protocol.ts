import { z } from "zod";

export const workloadLifetime = 300;

export const workloadRotationInterval = 30 * 24 * 60 * 60;

export const workloadKeyGrace = workloadLifetime + 60;

export const workloadAudience = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[!-~]+$/);

export const workloadToken = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().int(),
});

export const workloadIssuer = z.url().refine((value) => {
  const url = new URL(value);

  return (
    url.protocol === "https:" &&
    url.pathname === "/workload" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
});
