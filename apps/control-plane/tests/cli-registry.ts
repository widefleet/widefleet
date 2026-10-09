import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { cliPlatform, cliPlatforms } from "../../../tools/cli-platforms.ts";

const execute = promisify(execFile);

const packageManifest = z.object({
  name: z.string(),
  version: z.string(),
  os: z.array(z.string()),
  cpu: z.array(z.string()),
  libc: z.array(z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  bin: z.record(z.string(), z.string()).optional(),
  engines: z.record(z.string(), z.string()).optional(),
});

// Install the exact release bytes without publishing packages or relying on npm.
export async function startCliRegistry(archive: string) {
  const version = z.string().parse(/^widefleet-(\d+\.\d+\.\d+)\.tgz$/.exec(basename(archive))?.[1]);
  const directory = dirname(archive);
  const platform = cliPlatform(process.platform, process.arch);
  const downloads: string[] = [];
  const tarballs = new Map<string, Buffer>();
  const manifests = new Map<string, z.infer<typeof packageManifest>>();

  for (const name of ["widefleet", `widefleet-${platform.name}`]) {
    const file = `${name}-${version}.tgz`;
    const bytes = await readFile(join(directory, file));
    const digest = createHash("sha256").update(bytes).digest("hex");

    if ((await readFile(join(directory, `${file}.sha256`), "utf8")).trim() !== `${digest}  ${file}`)
      throw new Error(`Checksum mismatch: ${file}`);

    const { stdout } = await execute("tar", ["-xOf", file, "package/package.json"], {
      cwd: directory,
    });

    const manifest = packageManifest.parse(JSON.parse(stdout));

    if (manifest.name !== name || manifest.version !== version)
      throw new Error(`Unexpected package identity: ${file}`);
    tarballs.set(file, bytes);
    manifests.set(name, manifest);
  }

  // Incompatible packages have metadata, but downloading their tarballs fails.
  for (const entry of cliPlatforms) {
    if (entry.name === platform.name) continue;
    const name = `widefleet-${entry.name}`;
    manifests.set(name, { name, version, os: [entry.os], cpu: [entry.cpu] });
  }

  let origin = "";

  const server = createServer((request, response) => {
    request.resume();
    const path = decodeURIComponent(request.url ?? "").slice(1);

    // Record failed downloads too: optional dependencies can swallow a 404.
    if (path.endsWith(".tgz")) downloads.push(path);
    const bytes = tarballs.get(path);

    if (bytes) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(bytes);

      return;
    }

    const manifest = manifests.get(path);

    if (!manifest) {
      response.writeHead(404).end();

      return;
    }

    const file = `${manifest.name}-${version}.tgz`;

    // npm includes integrity even for incompatible targets. Without it pnpm
    // fetches their tarballs before deciding whether to install them.
    const tarball = tarballs.get(file);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        name: manifest.name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            ...manifest,
            dist: {
              tarball: `${origin}/${file}`,
              integrity: `sha512-${createHash("sha512")
                .update(tarball ?? file)
                .digest("base64")}`,
            },
          },
        },
      }),
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;

  return {
    url: origin,
    version,
    downloads,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
