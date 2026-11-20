// Applies the dependency patches a project declares for pnpm
// (`patchedDependencies` in pnpm-workspace.yaml), so a server build installs
// the same package contents as `pnpm install` before `widefleet deploy`.
// Patches apply exactly, as pnpm applies them: a hunk whose context, removed
// lines or final newline differ fails the build instead of applying elsewhere.
import { parse } from "yaml";
import { z } from "zod";
import { BuildError } from "./configuration.ts";

type Line = { kind: " " | "-" | "+"; text: string; noNewline: boolean };

type Hunk = { oldStart: number; oldCount: number; lines: Line[] };

type FilePatch = {
  from: string;
  to: string;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
};

const workspace = z.looseObject({
  patchedDependencies: z.record(z.string(), z.string()).optional(),
});

// `name@version` or `name`; scoped names start with `@`.
const dependency = /^(@?[^@]+)(?:@(.+))?$/;

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const escapes = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["t", "\t"],
  ["n", "\n"],
  ["v", "\v"],
  ["f", "\f"],
  ["r", "\r"],
  ['"', '"'],
  ["\\", "\\"],
]);

// Git quotes paths with special characters as C strings, with UTF-8 bytes as
// octal escapes, such as "b/caf\303\251.js".
const unquote = (label: string, value: string) => {
  if (!value.startsWith('"')) return value;

  if (!value.endsWith('"') || value.length < 2)
    throw new BuildError(`The patch ${label} has an invalid path`);
  const bytes: number[] = [];
  const body = value.slice(1, -1);

  for (let index = 0; index < body.length; index++) {
    const character = body.charAt(index);

    if (character !== "\\") {
      bytes.push(...new TextEncoder().encode(character));
      continue;
    }

    const next = body.charAt(index + 1);
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1))?.[0];
    const escaped = escapes.get(next);

    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
    } else if (escaped !== undefined) {
      bytes.push(...new TextEncoder().encode(escaped));
      index++;
    } else throw new BuildError(`The patch ${label} has an invalid path`);
  }

  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new Uint8Array(bytes));
};

// The paths of a `diff --git a/… b/…` line, which are the only paths of
// empty-file and mode-only changes. Unquoted paths with spaces are ambiguous
// there unless both are equal; renames name theirs in `rename` lines.
const gitPaths = (label: string, value: string) => {
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(value);

  if (quoted?.[1] && quoted[2])
    return {
      from: unquote(label, quoted[1]).replace(/^a\//, ""),
      to: unquote(label, quoted[2]).replace(/^b\//, ""),
    };
  const length = (value.length - 5) / 2;
  const path = value.slice(2, 2 + length);

  return Number.isInteger(length) &&
    value.startsWith("a/") &&
    value.slice(2 + length, 5 + length) === " b/" &&
    value.slice(5 + length) === path
    ? { from: path, to: path }
    : {};
};

// Header paths, without a trailing timestamp, as `a/…` or `b/…`; null for /dev/null.
const headerPath = (label: string, value: string) => {
  const path = unquote(label, value.split("\t")[0] ?? "");

  return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
};

type Pending = {
  from?: string;
  to?: string;
  created?: boolean;
  deleted?: boolean;
  hunks: Hunk[];
};

const parsePatch = (label: string, text: string) => {
  const files: FilePatch[] = [];
  const lines = text.split("\n");
  let current: Pending | undefined;

  const finish = () => {
    if (!current) return;
    const { from, to, created = false, deleted = false, hunks } = current;

    if (from === undefined && to === undefined)
      throw new BuildError(`The patch ${label} has a file without paths`);
    const path = to ?? from ?? "";

    // Mode-only changes have no effect on installed text files.
    if (hunks.length > 0 || from !== to || created || deleted)
      files.push({ from: from ?? path, to: to ?? path, created, deleted, hunks });
    current = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      finish();
      current = { ...gitPaths(label, line.slice(11)), hunks: [] };
      continue;
    }

    if (line.startsWith("--- ")) {
      // A unified diff without Git headers starts its next file here.
      if (!current || current.hunks.length > 0) {
        finish();
        current = { hunks: [] };
      }

      const path = headerPath(label, line.slice(4));

      if (path === null) current.created = true;
      else current.from = path;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("rename from ")) current.from = unquote(label, line.slice(12));
    else if (line.startsWith("rename to ")) current.to = unquote(label, line.slice(10));
    else if (line.startsWith("copy from ") || line.startsWith("copy to "))
      throw new BuildError(`The patch ${label} copies files, which is not supported`);
    else if (line.startsWith("GIT binary patch") || line.startsWith("Binary files "))
      throw new BuildError(`The patch ${label} changes binary files, which is not supported`);
    else if (line.startsWith("new file mode")) current.created = true;
    else if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("+++ ")) {
      const path = headerPath(label, line.slice(4));

      if (path === null) current.deleted = true;
      else current.to = path;
    } else if (line.startsWith("@@")) {
      const header = hunkHeader.exec(line);

      if (!header?.[1]) throw new BuildError(`The patch ${label} is malformed`);

      const hunk: Hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        lines: [],
      };

      let oldLeft = hunk.oldCount;
      let newLeft = header[4] === undefined ? 1 : Number(header[4]);

      // A hunk's lines are exactly its declared counts, so removed lines such
      // as "-- comment" are never read as file headers.
      while (oldLeft > 0 || newLeft > 0) {
        index++;

        if (index >= lines.length) throw new BuildError(`The patch ${label} is truncated`);
        const content = lines[index] ?? "";

        if (content.startsWith("\\")) {
          const previous = hunk.lines.at(-1);

          if (previous) previous.noNewline = true;
          continue;
        }

        // Some tools write an empty context line without its leading space.
        const kind = content === "" ? " " : content.charAt(0);

        if (kind !== " " && kind !== "-" && kind !== "+")
          throw new BuildError(`The patch ${label} is malformed`);

        if (kind !== "+") oldLeft--;

        if (kind !== "-") newLeft--;

        if (oldLeft < 0 || newLeft < 0) throw new BuildError(`The patch ${label} is malformed`);
        hunk.lines.push({ kind, text: content.slice(1), noNewline: false });
      }

      // The marker for the hunk's last line follows it.
      if ((lines[index + 1] ?? "").startsWith("\\")) {
        index++;
        const last = hunk.lines.at(-1);

        if (last) last.noNewline = true;
      }

      current.hunks.push(hunk);
    }
  }

  finish();

  return files;
};

// A file's lines and whether it ends with a newline. An empty file has none.
const split = (content: string) => {
  const lines = content === "" ? [] : content.split("\n");
  const newline = content.endsWith("\n");

  if (newline) lines.pop();

  return { lines, newline };
};

const applyFile = (label: string, file: FilePatch, original: string) => {
  const failure = () => new BuildError(`The patch ${label} does not apply to ${file.from}`);
  const { lines, newline } = split(original);
  const output: string[] = [];
  let index = 0;
  let endsWithNewline = newline;

  for (const hunk of file.hunks) {
    // Unified diffs number lines from 1. Without old lines, the start names
    // the line after which the hunk inserts.
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;

    if (start < index || start > lines.length) throw failure();
    output.push(...lines.slice(index, start));
    index = start;
    let last: Line | undefined;

    for (const line of hunk.lines) {
      if (line.kind !== "+") {
        if (lines[index] !== line.text) throw failure();
        index++;

        // The old file's final newline must be as the patch describes.
        if (index === lines.length && line.noNewline === newline) throw failure();

        if (line.noNewline && index !== lines.length) throw failure();
      }

      if (line.kind !== "-") {
        output.push(line.text);
        last = line;
      }
    }

    // A hunk that reaches the end of the file decides the new final newline. If
    // it only removes lines there, the earlier line that now ends the file kept
    // its newline.
    if (index === lines.length) endsWithNewline = last ? !last.noNewline : true;
  }

  output.push(...lines.slice(index));

  return output.length === 0 ? "" : `${output.join("\n")}${endsWithNewline ? "\n" : ""}`;
};

export const projectPatches = (files: Readonly<Record<string, string>>) => {
  const declaration = files["pnpm-workspace.yaml"];

  if (declaration === undefined) return [];
  let document: unknown;

  try {
    document = parse(declaration);
  } catch {
    throw new BuildError("pnpm-workspace.yaml is not valid YAML");
  }

  const parsed = workspace.safeParse(document);

  if (!parsed.success) throw new BuildError("pnpm-workspace.yaml is invalid");

  return Object.entries(parsed.data.patchedDependencies ?? {}).map(([key, path]) => {
    const [, name, version] = dependency.exec(key) ?? [];
    const text = files[path.replace(/^\.\//, "")];

    if (!name) throw new BuildError(`The patched dependency ${key} is invalid`);

    if (text === undefined) throw new BuildError(`The patch file ${path} is missing`);

    return { key, name, version, changes: parsePatch(key, text) };
  });
};

/**
 * Patches for `installDependencies`. Failures inside the installer become
 * warnings, so call `verify()` after installing to fail the build instead.
 */
export const dependencyPatches = (patches: ReturnType<typeof projectPatches>) => {
  const applied = new Set<string>();
  const failures: string[] = [];

  return {
    patchPackage: (name: string, version: string) => {
      const patch = patches.find(
        (candidate) =>
          candidate.name === name &&
          (candidate.version === undefined || candidate.version === version),
      );

      if (!patch) return undefined;

      return {
        files: [...new Set(patch.changes.flatMap((change) => [change.from, change.to]))],
        apply(packageFiles: Readonly<Record<string, string>>) {
          try {
            const result = { ...packageFiles };

            for (const change of patch.changes) {
              const original = result[change.from];

              if (change.created ? original !== undefined : original === undefined)
                throw new BuildError(`The patch ${patch.key} does not apply to ${change.from}`);
              const changed = applyFile(patch.key, change, original ?? "");

              if (change.deleted) {
                // A deletion must remove exactly the installed contents.
                if (changed !== "")
                  throw new BuildError(`The patch ${patch.key} does not apply to ${change.from}`);
                delete result[change.from];
                continue;
              }

              if (change.from !== change.to) {
                if (result[change.to] !== undefined)
                  throw new BuildError(`The patch ${patch.key} does not apply to ${change.to}`);
                delete result[change.from];
              }

              result[change.to] = changed;
            }

            applied.add(patch.key);

            return result;
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      };
    },
    // Installs leave devDependencies out of bundles and include only the
    // declarations documentation reads, so a patch for a package that is not
    // installed is not an error. One for another installed version is.
    verify: (installed: readonly string[]) => {
      if (failures.length > 0) throw new BuildError(failures.join("\n"));
      const names = new Set(installed.map((entry) => dependency.exec(entry)?.[1]));

      const mismatched = patches.filter(
        (patch) => !applied.has(patch.key) && names.has(patch.name),
      );

      if (mismatched.length > 0)
        throw new BuildError(
          `No installed package matches the patched dependency ${mismatched.map((patch) => patch.key).join(", ")}`,
        );
    },
  };
};
