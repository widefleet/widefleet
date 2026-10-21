import type { RateLimit } from "@cloudflare/workers-types";
import type { BetterAuthOptions } from "better-auth";

export type CloudflareAuthRateLimitBindings = Partial<
  Record<`AUTH_RATE_LIMIT_${number}_${number}`, RateLimit>
>;

export const cloudflareAuthRateLimit = (
  bindings: CloudflareAuthRateLimitBindings,
  platformUrl: string,
) =>
  ({
    enabled: true,
    // The device plugin defaults to its 30-minute code lifetime as the request
    // window. Cloudflare supports only 10 or 60 seconds; code expiry is unchanged.
    customRules: { "/device": { max: 5, window: 60 } },
    customStorage: {
      consume: async (key, rule) => {
        // Better Auth selects the endpoint policy; Wrangler supplies its binding.
        const name = `AUTH_RATE_LIMIT_${rule.max}_${rule.window}` as const;
        const limiter = bindings[name];

        if (!limiter) throw new Error(`Missing Cloudflare authentication rate limit: ${name}`);
        const { success } = await limiter.limit({ key: `${platformUrl}:${key}` });

        // Cloudflare does not expose the remaining window. A full window is a
        // conservative retry delay; counters are local to each Cloudflare location.
        return { allowed: success, retryAfter: success ? null : rule.window };
      },
    },
  }) satisfies NonNullable<BetterAuthOptions["rateLimit"]>;
