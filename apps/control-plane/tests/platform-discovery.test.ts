import dns from "node:dns/promises";
import https from "node:https";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  cloudPlatformUrl,
  companyDomain,
  companySignInUrl,
  discoveredPlatformUrl,
  discoverPlatform,
  platformFromDocument,
  platformFromTxt,
} from "../src/lib/server/platform-discovery.ts";
import { createCertificates } from "./installation/certificates.ts";

afterEach(() => vi.restoreAllMocks());

describe("Company platform discovery", () => {
  it("normalizes domains and rejects URLs, addresses and DNS delimiters", () => {
    expect(companyDomain.parse(" EXAMPLE.COM. ")).toBe("example.com");
    expect(companyDomain.parse("bücher.example")).toBe("xn--bcher-kva.example");

    for (const value of [
      "",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "https://example.com",
      "example.com:443",
      "employee@example.com",
      "example.com/path",
      "example.com?x",
      "example.com#x",
      "example%2ecom",
      "example..com",
      "example-.com",
      "example_com.test",
      `${"x".repeat(64)}.com`,
    ])
      expect(companyDomain.safeParse(value).success, value).toBe(false);
  });

  it("accepts only exact HTTPS origins and a single discovery document field", () => {
    expect(discoveredPlatformUrl.parse("https://platform.example.test:443/")).toBe(
      "https://platform.example.test",
    );

    for (const value of [
      "http://localhost",
      "https://user:secret@example.test",
      "https://example.test/path",
      "https://example.test?",
      "https://example.test#",
      "https://exam\tple.test",
    ])
      expect(discoveredPlatformUrl.safeParse(value).success, value).toBe(false);

    expect(platformFromDocument('{"platform_url":"https://platform.example.test"}')).toBe(
      "https://platform.example.test",
    );

    for (const body of [
      "{}",
      '{"platform_url":"http://localhost"}',
      '{"platform_url":"https://example.test","extra":true}',
      '{"platform_url":"https://a.test","platform_url":"https://b.test"}',
      "<html>Not found</html>",
    ])
      expect(() => platformFromDocument(body), body).toThrow();
  });

  it("combines TXT chunks, accepts duplicates, and rejects conflicts or malformed records", () => {
    expect(platformFromTxt([])).toBeNull();
    expect(
      platformFromTxt([
        ["url=https://", "platform.example.test"],
        ["url=https://platform.example.test:443/"],
      ]),
    ).toBe("https://platform.example.test");
    expect(() => platformFromTxt([["url=https://a.test"], ["url=https://b.test"]])).toThrow(
      "Conflicting",
    );
    expect(() => platformFromTxt([["https://example.test"]])).toThrow();
    expect(() => platformFromTxt([["url=http://localhost"]])).toThrow();
  });

  it("uses published TXT without contacting either the company website or Cloud", async () => {
    vi.spyOn(dns, "resolveTxt").mockResolvedValue([["url=https://platform.example.test"]]);
    const addresses = vi.spyOn(dns, "resolve4");
    const request = vi.spyOn(https, "get");
    expect(await discoverPlatform("example.test")).toBe("https://platform.example.test");
    expect(dns.resolveTxt).toHaveBeenCalledWith("_widefleet.example.test.");
    expect(addresses).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not fall back from conflicting or malformed TXT records", async () => {
    vi.spyOn(dns, "resolveTxt").mockResolvedValue([["url=https://a.test"], ["url=https://b.test"]]);
    const request = vi.spyOn(https, "get");
    await expect(discoverPlatform("example.test")).rejects.toThrow("Conflicting");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not request documents from private addresses, mixed records or failed address lookup", async () => {
    vi.spyOn(dns, "resolveTxt").mockResolvedValue([]);
    const ipv4 = vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34", "127.0.0.1"]);
    vi.spyOn(dns, "resolve6").mockResolvedValue([]);
    const request = vi.spyOn(https, "get");
    await expect(discoverPlatform("example.test")).rejects.toThrow("public addresses");
    ipv4.mockRejectedValue({ code: "ETIMEOUT" });
    await expect(discoverPlatform("example.test")).rejects.toMatchObject({ code: "ETIMEOUT" });
    expect(request).not.toHaveBeenCalled();
  });

  it("only carries the entered email to the company sign-in page", () => {
    expect(companySignInUrl("https://platform.example.test", "employee+team@example.test")).toBe(
      "https://platform.example.test/sign-in?email=employee%2Bteam%40example.test",
    );
  });

  it("allows Cloud for a mail domain with no TXT mapping or website addresses", async () => {
    vi.spyOn(dns, "resolveTxt").mockResolvedValue([]);
    vi.spyOn(dns, "resolve4").mockRejectedValue({ code: "ENODATA" });
    vi.spyOn(dns, "resolve6").mockResolvedValue([]);
    const request = vi.spyOn(https, "get");
    expect(await discoverPlatform("example.test")).toBe(cloudPlatformUrl);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not transfer device grants, invitations or OAuth continuations to a different issuer", () => {
    for (const next of [
      "/device?user_code=SECRET",
      "/invitations/private-id",
      "/api/auth/oauth2/authorize?client_id=private",
    ])
      expect(() =>
        companySignInUrl("https://platform.example.test", "employee@example.test", next),
      ).toThrow("widefleet login --domain example.test");

    expect(
      companySignInUrl(
        "https://platform.example.test",
        "employee@example.test",
        "/settings?tab=private",
      ),
    ).toBe("https://platform.example.test/sign-in?email=employee%40example.test");
  });
});

describe("Company discovery over HTTPS", () => {
  let directory: string;
  let server: ReturnType<typeof https.createServer>;
  let certificate: Buffer;
  let port: number;
  let status = 200;
  let body = "";

  const requests: {
    path: string;
    authorization: string | undefined;
    cookie: string | undefined;
  }[] = [];

  const get = https.get.bind(https);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet-discovery-"));
    const files = await createCertificates(directory, ["example.test"]);
    certificate = await readFile(files.ca);
    server = https.createServer(
      { key: await readFile(files.key), cert: await readFile(files.certificate) },
      (request, response) => {
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
        });
        response.writeHead(status, {
          "content-type": "application/json",
          location: "https://redirect.example.test",
        });
        response.end(body);
      },
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = z.object({ port: z.number() }).parse(server.address()).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  });

  const fixture = () => {
    requests.length = 0;
    status = 200;
    body = '{"platform_url":"https://platform.example.test"}';
    const txt = vi.spyOn(dns, "resolveTxt").mockResolvedValue([]);
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"]);
    vi.spyOn(dns, "resolve6").mockRejectedValue({ code: "ENODATA" });

    const request = vi.spyOn(https, "get").mockImplementation((url, options, listener) =>
      get(
        url,
        {
          ...options,
          port,
          ca: certificate,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          },
        },
        listener,
      ),
    );

    return { txt, request };
  };

  it("uses HTTPS without email, cookies or tokens when TXT is absent or unavailable", async () => {
    const { txt, request } = fixture();
    expect(await discoverPlatform("example.test")).toBe("https://platform.example.test");
    txt.mockRejectedValue({ code: "ETIMEOUT" });
    expect(await discoverPlatform("example.test")).toBe("https://platform.example.test");
    expect(requests).toEqual(
      Array.from({ length: 2 }, () => ({
        path: "/.well-known/widefleet",
        authorization: undefined,
        cookie: undefined,
      })),
    );
    const lookup = request.mock.calls[0]?.[1].lookup;
    const callback = vi.fn();
    lookup?.("example.test", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it.each([404, 410])(
    "uses Cloud only for an absent TXT record and an absent document (%s)",
    async (missing) => {
      const { txt } = fixture();
      status = missing;
      expect(await discoverPlatform("example.test")).toBe(cloudPlatformUrl);
      txt.mockRejectedValue({ code: "ENOTFOUND" });
      expect(await discoverPlatform("example.test")).toBe(cloudPlatformUrl);
      txt.mockRejectedValue({ code: "ETIMEOUT" });
      await expect(discoverPlatform("example.test")).rejects.toThrow(
        "Company discovery is unavailable",
      );
    },
  );

  it("keeps all checked IPv4 and IPv6 addresses available for connection fallback", async () => {
    const { request } = fixture();
    vi.mocked(dns.resolve4).mockResolvedValue(["93.184.216.34", "93.184.216.35"]);
    vi.mocked(dns.resolve6).mockResolvedValue(["2606:4700:4700::1111"]);
    expect(await discoverPlatform("example.test")).toBe("https://platform.example.test");
    const options = request.mock.calls[0]?.[1];
    const callback = vi.fn();
    options?.lookup?.("example.test", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it.each([301, 302, 401, 403, 500, 503])(
    "rejects HTTPS status %s without following redirects or defaulting to Cloud",
    async (failure) => {
      fixture();
      status = failure;
      await expect(discoverPlatform("example.test")).rejects.toThrow(
        `HTTPS discovery returned ${failure}`,
      );
      expect(requests).toHaveLength(1);
    },
  );

  it.each(["{}", '{"platform_url":"http://localhost"}', "x".repeat(8193)])(
    "rejects invalid and oversized discovery documents",
    async (document) => {
      fixture();
      body = document;
      await expect(discoverPlatform("example.test")).rejects.toThrow();
    },
  );
});
