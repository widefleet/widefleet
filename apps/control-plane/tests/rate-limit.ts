import { expect } from "vitest";

export const expectRateLimitedBurst = async (
  request: () => Promise<Response>,
  policy: { max: number; window: number; clockAligned: boolean; admittedStatus: number },
) => {
  // Native Cloudflare counters reset at wall-clock boundaries. A burst spanning
  // two windows can admit twice the limit, but must still reject excess requests.
  const started = Date.now();
  const responses = await Promise.all(Array.from({ length: 2 * policy.max + 1 }, request));

  const windows = policy.clockAligned
    ? Math.floor(Date.now() / (policy.window * 1000)) -
      Math.floor(started / (policy.window * 1000)) +
      1
    : 1;

  const admitted = responses.filter((response) => response.status === policy.admittedStatus);
  const limited = responses.filter((response) => response.status === 429);
  expect(admitted.length).toBeGreaterThanOrEqual(policy.max);
  expect(admitted.length).toBeLessThanOrEqual(policy.max * windows);
  expect(limited.length).toBeGreaterThan(0);
  expect(admitted.length + limited.length).toBe(responses.length);

  for (const response of limited) {
    expect(Number(response.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(Number(response.headers.get("x-retry-after"))).toBeLessThanOrEqual(policy.window);
    expect(await response.json()).toMatchObject({
      message: "Too many requests. Please try again later.",
    });
  }

  return admitted;
};
