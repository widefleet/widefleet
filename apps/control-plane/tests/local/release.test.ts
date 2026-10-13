import { expect, it } from "vitest";
import { localRelease } from "../../local/release.ts";

const manifest = (digest: string) =>
  ["runtime", "agent", "control-plane"]
    .map(
      (component) =>
        `PLATFORM_${component.toUpperCase().replaceAll("-", "_")}_IMAGE=docker.io/widefleet/${component}@sha256:${digest.repeat(64)}`,
    )
    .join("\n");

const latest = (version: string) => {
  const response = new Response();

  Object.defineProperty(response, "url", {
    value: `https://github.com/widefleet/widefleet/releases/tag/v${version}`,
  });

  return response;
};

it("resolves each start against the latest release and reads only that release's manifest", async () => {
  for (const version of ["1.2.3", "1.2.4"]) {
    const requests: string[] = [];

    const images = await localRelease(async (input, options) => {
      requests.push(new Request(input).url);

      if (new Request(input).url.endsWith("/latest")) {
        expect(options?.method).toBe("HEAD");

        return latest(version);
      }

      return new Response(manifest("a"));
    });

    expect(requests).toEqual([
      "https://github.com/widefleet/widefleet/releases/latest",
      `https://github.com/widefleet/widefleet/releases/download/v${version}/widefleet-images-${version}.env`,
    ]);
    expect(images).toEqual([
      `docker.io/widefleet/runtime@sha256:${"a".repeat(64)}`,
      `docker.io/widefleet/agent@sha256:${"a".repeat(64)}`,
      `docker.io/widefleet/control-plane@sha256:${"a".repeat(64)}`,
      version,
    ]);
  }
});

it.each([
  "",
  manifest("a").replace("PLATFORM_AGENT_IMAGE=", "MISSING_AGENT="),
  manifest("a").replace("widefleet/agent", "someone/agent"),
  manifest("a").replace(/sha256:[a-f0-9]+/, "latest"),
  `${manifest("a")}\n${manifest("b")}`,
  manifest("a").replace("docker.io/widefleet/agent", "$(touch /tmp/not-executed)/agent"),
])("rejects an incomplete or invalid release manifest: %s", async (body) => {
  await expect(
    localRelease(async (input) =>
      new Request(input).url.endsWith("/latest") ? latest("1.2.3") : new Response(body),
    ),
  ).rejects.toThrow("image digest");
});

it("fails when the latest release's images are unavailable instead of choosing an older release", async () => {
  await expect(
    localRelease(async (input) =>
      new Request(input).url.endsWith("/latest")
        ? latest("1.2.3")
        : new Response("Not found", { status: 404 }),
    ),
  ).rejects.toThrow("1.2.3 image manifest is unavailable");
});

it("rejects a failed latest-release lookup", async () => {
  await expect(
    localRelease(async () => new Response("Unavailable", { status: 503 })),
  ).rejects.toThrow("latest Widefleet release");
});
