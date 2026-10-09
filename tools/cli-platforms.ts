export const cliPlatforms = [
  { name: "linux-x64-gnu", os: "linux", cpu: "x64", extension: "" },
  { name: "darwin-arm64", os: "darwin", cpu: "arm64", extension: "" },
  { name: "darwin-x64", os: "darwin", cpu: "x64", extension: "" },
  { name: "win32-x64-msvc", os: "win32", cpu: "x64", extension: ".exe" },
];

export function cliPlatform(os: string, cpu: string) {
  const platform = cliPlatforms.find((entry) => entry.os === os && entry.cpu === cpu);

  if (!platform)
    throw new Error(
      `Unsupported Widefleet platform: ${os}-${cpu}. Supported: ${cliPlatforms.map((entry) => entry.name).join(", ")}`,
    );

  return platform;
}
