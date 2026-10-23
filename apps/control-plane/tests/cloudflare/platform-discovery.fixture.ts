import dns from "node:dns/promises";
import type { RecordWithTtl, ResolveOptions, ResolveWithTtlOptions } from "node:dns";
import { discoverPlatform } from "../../src/lib/server/platform-discovery.ts";

function fixtureAddresses(hostname: string): Promise<string[]>;
function fixtureAddresses(
  hostname: string,
  options: ResolveWithTtlOptions,
): Promise<RecordWithTtl[]>;
function fixtureAddresses(
  hostname: string,
  options: ResolveOptions,
): Promise<string[] | RecordWithTtl[]>;
async function fixtureAddresses(_hostname: string, options?: ResolveOptions) {
  return options?.ttl ? [{ address: "93.184.216.34", ttl: 60 }] : ["93.184.216.34"];
}

// Local workerd fixture: every DNS query and outbound request is synthetic.
export default {
  async fetch(request: Request) {
    const scenario = new URL(request.url).searchParams.get("scenario");
    const requests: string[] = [];
    const original = globalThis.fetch;
    dns.resolveTxt = async () =>
      scenario === "txt" ? [["url=https://platform.example.test"]] : [];
    dns.resolve4 = fixtureAddresses;
    dns.resolve6 = async () => [];
    globalThis.fetch = async (input, init) => {
      const outbound = new Request(input, init);
      requests.push(outbound.url);

      if (outbound.redirect !== "manual") throw new Error("Discovery must disable redirects");

      if (outbound.headers.has("authorization") || outbound.headers.has("cookie"))
        throw new Error("Discovery must not send credentials");

      if (scenario === "absent") return new Response(null, { status: 404 });

      if (scenario === "html") return new Response("<html>Company homepage</html>");

      if (scenario === "unavailable") throw new Error("Synthetic network failure");

      if (scenario === "server-error") return new Response(null, { status: 503 });

      if (scenario === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://unexpected.example.test" },
        });

      return Response.json({ platform_url: "https://platform.example.test" });
    };

    try {
      return Response.json({
        platform_url: await discoverPlatform("example.test", "cloudflare"),
        requests,
      });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : "Discovery failed", requests },
        { status: 503 },
      );
    } finally {
      globalThis.fetch = original;
    }
  },
};
