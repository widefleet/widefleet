import { createWorker } from "@cloudflare/worker-bundler";
import { CodeMode } from "@opencode/codemode";
import { appDeclaration } from "@platform/contracts";
import { configProgram } from "@platform/contracts/builds";
import { Effect } from "effect";
import { z } from "zod";
import { BuildError, readLegacyDeclaration } from "./configuration.ts";

const filename = "widefleet.config.ts";

export const evaluateDeclaration = async (program: string) => {
  if (!configProgram.safeParse(program).success)
    throw new BuildError("The bundled widefleet.config.ts exceeds the configuration size limit");
  const runtime = CodeMode.make({ tools: {}, limits: { timeoutMs: 1000, maxOutputBytes: 65536 } });

  const result = await Effect.runPromise(
    runtime.execute(
      `let declaration; function widefleetConfig(value) { declaration = value; }\n(() => {\n${program}\n})();\nreturn declaration;`,
    ),
  );

  if (!result.ok) throw new BuildError(`Invalid ${filename}: ${result.error.message}`);

  if (result.truncated) throw new BuildError(`The result of ${filename} is too large`);
  const parsed = appDeclaration.safeParse(result.value);

  if (!parsed.success)
    throw new BuildError(`Invalid ${filename}: ${z.prettifyError(parsed.error)}`);

  return parsed.data;
};

export const readDeclaration = async (files: Readonly<Record<string, string>>) => {
  if (files[filename] === undefined) return readLegacyDeclaration(files);

  if (files["widefleet.jsonc"] !== undefined)
    throw new BuildError("Use only one of widefleet.config.ts and widefleet.jsonc");

  // Keep the project under its own directory. Its package.json and Wrangler
  // files remain importable without configuring the bundler's synthetic root.
  const sources = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [`project/${path}`, content]),
  );

  const entryPoint = "config-entry.js";
  sources[entryPoint] =
    'import config from "./project/widefleet.config.ts"; widefleetConfig(config);';

  try {
    const bundle = await createWorker({ files: sources, entryPoint });

    return await evaluateDeclaration(z.string().parse(bundle.modules[bundle.mainModule]));
  } catch (error) {
    if (error instanceof BuildError) throw error;
    throw new BuildError(`Cannot bundle ${filename}: ${String(error)}`);
  }
};
