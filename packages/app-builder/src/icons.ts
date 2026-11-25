// Renders PNG app icons with crates/platform-app-icons-wasm. The module renders
// bytes in memory; its WASI imports for files and the environment report that
// nothing is available.
import { generatedAppIcons } from "@platform/contracts";
import { decodeBase64, encodeBase64 } from "@platform/contracts/builds";
import { z } from "zod";
import appIcons from "./app-icons.wasm";
import { BuildError } from "./configuration.ts";

const errnoSuccess = 0;

const errnoBadDescriptor = 8;

const errnoNotImplemented = 52;

// The ABI's exports take and return i32 values.
const exportedFunction = z.custom<(...args: number[]) => number>(
  (value) => z.function().safeParse(value).success,
);

const moduleExports = z.object({
  memory: z.instanceof(WebAssembly.Memory),
  icons_input: exportedFunction,
  icons_run: exportedFunction,
  icons_output: exportedFunction,
  icons_output_len: exportedFunction,
});

const instantiate = () => {
  let memory: WebAssembly.Memory | undefined;

  const buffer = () => {
    if (!memory) throw new Error("The icon module has no memory yet");

    return memory.buffer;
  };

  const wasi = new Map<string, (...args: number[]) => number>([
    [
      "random_get",
      (pointer = 0, length = 0) => {
        crypto.getRandomValues(new Uint8Array(buffer(), pointer, length));

        return errnoSuccess;
      },
    ],
    [
      "environ_sizes_get",
      (count = 0, size = 0) => {
        new DataView(buffer()).setUint32(count, 0, true);
        new DataView(buffer()).setUint32(size, 0, true);

        return errnoSuccess;
      },
    ],
    ["environ_get", () => errnoSuccess],
    // No preopened directories.
    ["fd_prestat_get", () => errnoBadDescriptor],
    [
      "proc_exit",
      (code = 0) => {
        throw new Error(`Icon rendering exited with status ${code}`);
      },
    ],
  ]);

  const system = Object.fromEntries(
    WebAssembly.Module.imports(appIcons)
      .filter((entry) => entry.module === "wasi_snapshot_preview1")
      .map((entry) => [entry.name, wasi.get(entry.name) ?? (() => errnoNotImplemented)]),
  );

  const instance = moduleExports.parse(
    new WebAssembly.Instance(appIcons, { wasi_snapshot_preview1: system }).exports,
  );

  memory = instance.memory;

  return instance;
};

export const renderIcons = (svg: string) => {
  const source = decodeBase64(svg);
  const module = instantiate();

  new Uint8Array(module.memory.buffer).set(source, module.icons_input(source.byteLength));

  return {
    icons: generatedAppIcons.map(({ path, size, opaque }) => {
      const status = module.icons_run(size, opaque ? 1 : 0);

      const output = new Uint8Array(
        module.memory.buffer,
        module.icons_output(),
        module.icons_output_len(),
      ).slice();

      if (status !== 0) throw new BuildError(new TextDecoder().decode(output));

      return { path, png: encodeBase64(output) };
    }),
  };
};
