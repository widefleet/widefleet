import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import { z } from "zod";
import { InvalidOperation } from "./errors.ts";
import { localDestination } from "./navigation.ts";

export const cloudPlatformUrl = "https://app.widefleet.com";

const documentLimit = 8192;

const hasControlCharacter = (value: string) => {
  for (const character of value)
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;

  return false;
};

export const companyDomain = z
  .string()
  .trim()
  .transform((input, context) => {
    const value = input.endsWith(".") ? input.slice(0, -1) : input;
    const url = URL.parse(`https://${value}`);
    const domain = url?.hostname;

    if (
      !domain ||
      /[\s/\\:@?#%]/.test(value) ||
      hasControlCharacter(value) ||
      isIP(domain) ||
      domain.length > 242 ||
      !domain.includes(".") ||
      domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      context.addIssue({ code: "custom", message: "Enter a company domain such as example.com" });

      return z.NEVER;
    }

    return domain;
  });

export const discoveredPlatformUrl = z
  .string()
  .max(2048)
  .transform((value, context) => {
    const url = URL.parse(value);

    if (
      !url ||
      /\s/.test(value) ||
      hasControlCharacter(value) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.href !== `${url.origin}/`
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Discovery must specify one HTTPS platform origin without credentials, path, query or fragment",
      });

      return z.NEVER;
    }

    return url.origin;
  });

export const platformFromTxt = (records: string[][]) => {
  let selected: string | null = null;

  for (const chunks of records) {
    const record = chunks.join("");

    if (!record.startsWith("url=")) throw new Error("Invalid Widefleet TXT record");
    const origin = discoveredPlatformUrl.parse(record.slice(4));

    if (selected !== null && selected !== origin)
      throw new Error("Conflicting Widefleet TXT records; ask IT to publish a single platform URL");
    selected = origin;
  }

  return selected;
};

const deadline = async <T>(operation: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Company DNS lookup timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const absentRecord = (cause: unknown) => {
  if (z.object({ code: z.enum(["ENODATA", "ENOTFOUND"]) }).safeParse(cause).success) return [];
  throw cause;
};

export const platformFromDocument = (body: string) => {
  // A single JSON field also rejects duplicate keys, matching the native CLI.
  if (!/^\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/.test(body))
    throw new Error("HTTPS discovery must contain JSON with a single platform_url field");

  return z.strictObject({ platform_url: discoveredPlatformUrl }).parse(JSON.parse(body))
    .platform_url;
};

const platformFromHttps = async (domain: string, transport: "node" | "cloudflare") => {
  if (!isPublicRoutableHost(domain)) throw new Error("Company discovery requires a public domain");

  const addresses = (
    await deadline(
      Promise.all([
        dns.resolve4(domain).catch(absentRecord),
        dns.resolve6(domain).catch(absentRecord),
      ]),
    )
  ).flat();

  // A successful negative A/AAAA answer proves there is no HTTPS discovery
  // service. Mail-only domains do not need to host a website to use Cloud.
  if (!addresses.length) return null;

  if (!addresses.every(isPublicRoutableHost))
    throw new Error("Company discovery must resolve to public addresses");

  const address = addresses[0];

  if (!address) throw new Error("Company discovery has no address");

  // Workers has no custom DNS lookup hook. Its public fetch transport cannot use
  // the installation's private network bindings; keep redirects disabled here too.
  if (transport === "cloudflare") {
    const response = await fetch(`https://${domain}/.well-known/widefleet`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(10000),
    });

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();

      return null;
    }

    if (response.status !== 200) {
      await response.body?.cancel();

      throw new Error(`HTTPS discovery returned ${response.status}`);
    }

    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    if (!reader) throw new Error("HTTPS discovery returned an empty document");

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        size += value.length;

        if (size > documentLimit) throw new Error("HTTPS discovery document exceeds 8 KiB");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }

    return platformFromDocument(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  }

  return new Promise<string | null>((resolve, reject) => {
    // Pin every checked address while allowing Node to try alternate families.
    // Resolving the hostname again here would reintroduce DNS rebinding.
    const request = https.get(
      `https://${domain}/.well-known/widefleet`,
      {
        agent: false,
        signal: AbortSignal.timeout(10000),
        headers: { accept: "application/json" },
        lookup: (_hostname, options, callback) => {
          const family = isIP(address);

          if (options.all)
            callback(
              null,
              addresses.map((address) => ({ address, family: isIP(address) })),
            );
          else callback(null, address, family);
        },
      },
      (response) => {
        if (response.statusCode === 404 || response.statusCode === 410) {
          response.destroy();
          resolve(null);

          return;
        }

        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(`HTTPS discovery returned ${response.statusCode ?? "no status"}`));

          return;
        }

        let size = 0;
        const chunks: Uint8Array[] = [];

        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;

          if (size > documentLimit) {
            response.destroy(new Error("HTTPS discovery document exceeds 8 KiB"));

            return;
          }

          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(
              platformFromDocument(
                new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
              ),
            );
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );

    request.on("error", reject);
  });
};

export const discoverPlatform = async (
  input: string,
  transport: "node" | "cloudflare" = "node",
) => {
  const domain = companyDomain.parse(input);

  const records = await deadline(dns.resolveTxt(`_widefleet.${domain}.`)).catch(() => []);
  // A published Widefleet record is an explicit configuration. Invalid or
  // conflicting records still need correction instead of guessing their target.
  const published = platformFromTxt(records);

  if (published) return published;

  // The company's website is optional discovery, not a prerequisite for Cloud.
  // HTML fallbacks, redirects and outages supply no usable mapping. Keep the
  // transport's address checks, limits and redirect prohibition in effect.
  return (await platformFromHttps(domain, transport).catch(() => null)) ?? cloudPlatformUrl;
};

export const companySignInUrl = (origin: string, email: string, next = "/") => {
  const path = new URL(localDestination(next), cloudPlatformUrl).pathname;

  if (
    ["/device", "/invitations", "/api/auth"].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  )
    throw new InvalidOperation({
      code: "CONFLICT",
      message: `Your company uses ${origin}. For CLI access, run widefleet login --domain ${email.slice(email.lastIndexOf("@") + 1)}. For invitations, use the organization's sign-in link.`,
    });

  const url = new URL("/sign-in", discoveredPlatformUrl.parse(origin));
  url.searchParams.set("email", email);

  return url.href;
};
