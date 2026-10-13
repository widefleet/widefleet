export const localRelease = async (request = fetch) => {
  const base = "https://github.com/widefleet/widefleet/releases";

  const latest = await request(`${base}/latest`, {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });

  const version = latest.url.match(/\/widefleet\/widefleet\/releases\/tag\/v(\d+\.\d+\.\d+)$/)?.[1];

  if (!latest.ok || !version) throw new Error("Could not identify the latest Widefleet release");

  const response = await request(`${base}/download/v${version}/widefleet-images-${version}.env`, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`Widefleet ${version} image manifest is unavailable`);

  const manifest = await response.text();

  const image = (component: string) => {
    const variable = `PLATFORM_${component.toUpperCase().replaceAll("-", "_")}_IMAGE`;

    const entries = manifest.split("\n").filter((line) => line.startsWith(`${variable}=`));

    const value = entries[0]?.slice(variable.length + 1).trim();

    if (
      entries.length !== 1 ||
      !value ||
      !new RegExp(`^docker\\.io/widefleet/${component}@sha256:[a-f0-9]{64}$`).test(value)
    )
      throw new Error(`Widefleet ${version} has no valid ${component} image digest`);

    return value;
  };

  return [image("runtime"), image("agent"), image("control-plane"), version];
};

if (import.meta.main) console.info((await localRelease()).join(" "));
