#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cliPlatform } from "./cli-platforms.ts";

function launch() {
  const platform = cliPlatform(process.platform, process.arch);
  const dependency = `widefleet-${platform.name}`;
  const require = createRequire(import.meta.url);
  let executable: string;

  try {
    executable = require.resolve(`${dependency}/widefleet`);
  } catch {
    throw new Error(
      `The native CLI package ${dependency} is missing. Reinstall widefleet with optional dependencies enabled. Linux requires glibc.`,
    );
  }

  const child = spawn(executable, process.argv.slice(2), { stdio: "inherit" });

  const interrupt = () => {
    // Windows delivers console Ctrl+C to both processes. child.kill('SIGINT')
    // would terminate the CLI before its console handler can finish.
    if (process.platform !== "win32") child.kill("SIGINT");
  };

  const terminate = () => child.kill("SIGTERM");

  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  child.on("error", (error) => {
    console.error(`Could not start Widefleet: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
}

try {
  launch();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not launch Widefleet");
  process.exitCode = 1;
}
