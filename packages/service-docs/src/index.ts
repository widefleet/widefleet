// Runs the service documentation module (crates/platform-service-docs-wasm) over
// an in-memory, read-only file system. The module uses tsrs's WebAssembly ABI:
// `tsrs_input`, `tsrs_run` and `tsrs_output`, file access through the
// `tsrs_host` imports, and a minimal WASI preview 1 for clocks, randomness,
// standard error and exit.
import { serviceDocumentation } from "@platform/contracts";
import { z } from "zod";

export interface DocumentationRequest {
  /** Absolute project directory, using `/` separators. */
  project: string;
  /** Absolute path of the bundled Worker in `files`. */
  bundle: string;
  /** Absolute path of the bundle's external source map in `files`. */
  map: string;
  /** The original entry module, which selects the entry mode. */
  entry?: string;
  /** Exported names published as service entrypoints. */
  entrypoints: readonly string[];
  /** The project, its declarations and the bundle, by absolute path. */
  files: ReadonlyMap<string, string>;
}

export interface DocumentationResult {
  /** The `service_documentation` value of the Worker metadata. */
  documentation: z.infer<typeof serviceDocumentation>;
  /** Linear memory at the end of the run, which is also its peak. */
  memoryBytes: number;
}

export class DocumentationError extends Error {}

const errnoSuccess = 0;

const errnoBadDescriptor = 8;

const errnoNotImplemented = 52;

const notFound = -1;

const encoder = new TextEncoder();

const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

// The ABI's exports take and return i32 values.
const exportedFunction = z.custom<(...args: number[]) => number>(
  (value) => z.function().safeParse(value).success,
);

const moduleExports = z.object({
  memory: z.instanceof(WebAssembly.Memory),
  tsrs_input: exportedFunction,
  tsrs_run: exportedFunction,
  tsrs_output: exportedFunction,
  tsrs_output_len: exportedFunction,
});

const normalize = (path: string) => {
  const parts: string[] = [];

  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") parts.pop();
    else parts.push(part);
  }

  return `/${parts.join("/")}`;
};

const parent = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));

// Files by path, and each directory's entries, as the module lists and stats them.
const fileSystem = (files: ReadonlyMap<string, string>) => {
  const contents = new Map<string, Uint8Array>();
  const directories = new Map<string, Map<string, "d" | "f">>([["/", new Map()]]);

  for (const [path, content] of files) {
    let current = normalize(path);
    contents.set(current, encoder.encode(content));
    let kind: "d" | "f" = "f";

    while (current !== "/") {
      const directory = parent(current);
      const entries = directories.get(directory) ?? new Map<string, "d" | "f">();
      entries.set(current.slice(directory === "/" ? 1 : directory.length + 1), kind);
      directories.set(directory, entries);
      current = directory;
      kind = "d";
    }
  }

  return { contents, directories };
};

/**
 * Documents a Worker's service entrypoints. Each call instantiates `module`
 * afresh; the module keeps process-wide state and its memory never shrinks.
 */
export const documentServices = (
  module: WebAssembly.Module,
  request: DocumentationRequest,
): DocumentationResult => {
  const { contents, directories } = fileSystem(request.files);
  const stderr: string[] = [];
  let memory: WebAssembly.Memory | undefined;
  let staged: Uint8Array = new Uint8Array(0);

  const bytes = (pointer: number, length: number) => {
    if (!memory) throw new DocumentationError("The module has no memory");

    return new Uint8Array(memory.buffer, pointer >>> 0, length);
  };

  const view = () => {
    if (!memory) throw new DocumentationError("The module has no memory");

    return new DataView(memory.buffer);
  };

  const stage = (data: Uint8Array) => {
    staged = data;

    return staged.length;
  };

  const stageText = (text: string) => stage(encoder.encode(text));

  // The tsrs host protocol: read, stat, read a directory and resolve a path.
  // Write operations fail because documentation never writes files.
  const fileOperations = [
    (path: string) => {
      const file = contents.get(path);

      return file ? stage(file) : notFound;
    },
    (path: string) => {
      const file = contents.get(path);

      if (file) return stageText(`f ${file.length} 0`);

      return directories.has(path) ? stageText("d 0 0") : notFound;
    },
    (path: string) => {
      const directory = directories.get(path);

      return directory
        ? stageText([...directory].map(([name, kind]) => `${kind}${name}\0`).join(""))
        : notFound;
    },
    (path: string) => (contents.has(path) || directories.has(path) ? stageText(path) : notFound),
  ];

  const host = {
    fs: (operation: number, pointer: number, length: number) => {
      const handle = fileOperations[operation];

      if (!handle) return -2 - stageText("The documentation file system is read-only");

      return handle(normalize(decoder.decode(bytes(pointer, length))));
    },
    fs_take: (pointer: number) => {
      bytes(pointer, staged.length).set(staged);
    },
  };

  const wasi = new Map<string, (...args: number[]) => number>([
    [
      "environ_sizes_get",
      (count = 0, size = 0) => {
        view().setUint32(count, 0, true);
        view().setUint32(size, 0, true);

        return errnoSuccess;
      },
    ],
    ["environ_get", () => errnoSuccess],
    [
      "clock_time_get",
      (_clock = 0, _precision = 0, out = 0) => {
        view().setBigUint64(out, BigInt(Date.now()) * 1_000_000n, true);

        return errnoSuccess;
      },
    ],
    [
      "random_get",
      (pointer = 0, length = 0) => {
        for (let offset = 0; offset < length; offset += 65536)
          crypto.getRandomValues(bytes(pointer + offset, Math.min(65536, length - offset)));

        return errnoSuccess;
      },
    ],
    [
      "fd_write",
      (descriptor = 0, vectors = 0, count = 0, written = 0) => {
        if (descriptor !== 1 && descriptor !== 2) return errnoBadDescriptor;
        let total = 0;

        for (let index = 0; index < count; index++) {
          const pointer = view().getUint32(vectors + index * 8, true);
          const length = view().getUint32(vectors + index * 8 + 4, true);

          // Standard output carries no result; standard error explains failures.
          if (descriptor === 2) stderr.push(decoder.decode(bytes(pointer, length)));
          total += length;
        }

        view().setUint32(written, total, true);

        return errnoSuccess;
      },
    ],
    [
      "fd_fdstat_get",
      (descriptor = 0, out = 0) => {
        if (descriptor > 2) return errnoBadDescriptor;
        bytes(out, 24).fill(0);

        return errnoSuccess;
      },
    ],
    ["fd_prestat_get", () => errnoBadDescriptor],
    ["fd_prestat_dir_name", () => errnoBadDescriptor],
    ["fd_close", () => errnoBadDescriptor],
    [
      "proc_exit",
      (code = 0) => {
        throw new WasiExit(code);
      },
    ],
    ["sched_yield", () => errnoSuccess],
  ]);

  const system = Object.fromEntries(
    WebAssembly.Module.imports(module)
      .filter((entry) => entry.module === "wasi_snapshot_preview1")
      .map((entry) => [entry.name, wasi.get(entry.name) ?? (() => errnoNotImplemented)]),
  );

  const instance = moduleExports.parse(
    new WebAssembly.Instance(module, { tsrs_host: host, wasi_snapshot_preview1: system }).exports,
  );

  memory = instance.memory;

  const input = encoder.encode(
    [
      request.project,
      "0",
      request.project,
      request.bundle,
      request.map,
      request.entry ?? "-",
      ...request.entrypoints,
    ].join("\0"),
  );

  bytes(instance.tsrs_input(input.length), input.length).set(input);
  let status: number;

  try {
    status = instance.tsrs_run();
  } catch (error) {
    if (error instanceof WasiExit) status = error.code;
    else if (error instanceof WebAssembly.RuntimeError)
      throw new DocumentationError(`The service documentation module trapped: ${error.message}`);
    else throw error;
  }

  if (status !== 0)
    throw new DocumentationError(
      stderr.join("").trim() || `Service documentation failed with status ${status}`,
    );

  const output = bytes(instance.tsrs_output(), instance.tsrs_output_len());

  return {
    documentation: serviceDocumentation.parse(JSON.parse(decoder.decode(output))),
    memoryBytes: memory.buffer.byteLength,
  };
};
