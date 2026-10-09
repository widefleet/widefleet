import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function esbuildBinary() {
  const require = createRequire(import.meta.resolve("esbuild/package.json"));
  const executable = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";

  return require.resolve(`@esbuild/${process.platform}-${process.arch}/${executable}`);
}

export function runPnpm(args: string[], cwd: string, env = process.env) {
  const executable =
    process.env["npm_execpath"] ?? (process.platform === "win32" ? undefined : "pnpm");

  if (!executable)
    throw new Error("Run this tool through pnpm so its CLI entry point is available");

  // npm_execpath identifies the real pnpm entry point, including pnpm 12's
  // native executable. This avoids invoking a .cmd shim through execFile.
  const script = /\.[cm]?js$/.test(executable);

  return execute(script ? process.execPath : executable, script ? [executable, ...args] : args, {
    cwd,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
}
