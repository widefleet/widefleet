import { describe, expect, it } from "vitest";
import { dependencyPatches, projectPatches } from "./patches.ts";

const project = (patch: string) => ({
  "pnpm-workspace.yaml": 'patchedDependencies:\n  "@scope/library@1.0.0": patches/library.patch\n',
  "patches/library.patch": patch,
});

const apply = (patch: string, files: Record<string, string>) => {
  const patches = dependencyPatches(projectPatches(project(patch)));
  const change = patches.patchPackage("@scope/library", "1.0.0");

  if (!change) throw new Error("The patch does not match the package");

  return change.apply(files);
};

describe("dependency patches", () => {
  it("changes, adds and deletes package files exactly as written", () => {
    const patch = [
      "diff --git a/lib/index.js b/lib/index.js",
      "--- a/lib/index.js",
      "+++ b/lib/index.js",
      "@@ -1,3 +1,3 @@",
      " first",
      "-second",
      "+changed",
      " third",
      "@@ -5,2 +5,3 @@",
      " fifth",
      "+inserted",
      " sixth",
      "diff --git a/lib/added.js b/lib/added.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/lib/added.js",
      "@@ -0,0 +1 @@",
      "+export {};",
      "\\ No newline at end of file",
      "diff --git a/lib/removed.js b/lib/removed.js",
      "deleted file mode 100644",
      "--- a/lib/removed.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");

    expect(
      apply(patch, {
        "lib/index.js": "first\nsecond\nthird\nfourth\nfifth\nsixth\n",
        "lib/removed.js": "gone\n",
        "package.json": "{}",
      }),
    ).toEqual({
      "lib/index.js": "first\nchanged\nthird\nfourth\nfifth\ninserted\nsixth\n",
      "lib/added.js": "export {};",
      "package.json": "{}",
    });
  });

  it("adds and removes final newlines", () => {
    const remove = [
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const add = [
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "",
    ].join("\n");

    expect(apply(remove, { "a.js": "a\n" })).toEqual({ "a.js": "b" });
    expect(apply(add, { "a.js": "a" })).toEqual({ "a.js": "b\n" });
  });

  it("rejects changes whose context differs and records the failure", () => {
    const patch = ["--- a/a.js", "+++ b/a.js", "@@ -1 +1 @@", "-expected", "+changed", ""].join(
      "\n",
    );

    const patches = dependencyPatches(projectPatches(project(patch)));

    expect(() =>
      patches.patchPackage("@scope/library", "1.0.0")?.apply({ "a.js": "other\n" }),
    ).toThrow("The patch @scope/library@1.0.0 does not apply to a.js");
    expect(() => patches.verify(["@scope/library@1.0.0"])).toThrow(
      "The patch @scope/library@1.0.0 does not apply to a.js",
    );
  });

  it("matches only the declared version", () => {
    const patches = dependencyPatches(projectPatches(project("")));

    expect(patches.patchPackage("@scope/library", "2.0.0")).toBeUndefined();
    expect(patches.patchPackage("@scope/other", "1.0.0")).toBeUndefined();
    expect(() => patches.verify(["@scope/library@2.0.0"])).toThrow(
      "No installed package matches the patched dependency @scope/library@1.0.0",
    );
    // A patched development dependency is not installed for a bundle.
    expect(() => patches.verify(["@scope/other@1.0.0"])).not.toThrow();
  });

  it("reads removed lines that look like file headers as removals", () => {
    const patch = [
      "diff --git a/schema.sql b/schema.sql",
      "--- a/schema.sql",
      "+++ b/schema.sql",
      "@@ -1,3 +1,2 @@",
      " create table a;",
      "--- old",
      " create table b;",
      "",
    ].join("\n");

    expect(apply(patch, { "schema.sql": "create table a;\n-- old\ncreate table b;\n" })).toEqual({
      "schema.sql": "create table a;\ncreate table b;\n",
    });
  });

  it("inserts after the line a hunk without old lines names", () => {
    const patch = ["--- a/a.js", "+++ b/a.js", "@@ -1,0 +2 @@", "+inserted", ""].join("\n");

    expect(apply(patch, { "a.js": "first\nsecond\n" })).toEqual({
      "a.js": "first\ninserted\nsecond\n",
    });
  });

  it("deletes only files with the expected contents", () => {
    const patch = [
      "diff --git a/old.js b/old.js",
      "deleted file mode 100644",
      "--- a/old.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");

    expect(() => apply(patch, { "old.js": "changed\n" })).toThrow(
      "The patch @scope/library@1.0.0 does not apply to old.js",
    );
    expect(() => apply(patch, { "old.js": "gone" })).toThrow("does not apply to old.js");
    expect(apply(patch, { "old.js": "gone\n" })).toEqual({});
  });

  it("checks the installed file's final newline", () => {
    const patch = [
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "",
    ].join("\n");

    expect(() => apply(patch, { "a.js": "a\n" })).toThrow("does not apply to a.js");
  });

  it("decodes quoted paths and moves renamed files", () => {
    const quoted = [
      'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"',
      '--- "a/caf\\303\\251.js"',
      '+++ "b/caf\\303\\251.js"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    expect(apply(quoted, { "café.js": "a\n" })).toEqual({ "café.js": "b\n" });

    const renamed = [
      "diff --git a/old.js b/new.js",
      "similarity index 100%",
      "rename from old.js",
      "rename to new.js",
      "",
    ].join("\n");

    expect(apply(renamed, { "old.js": "kept\n" })).toEqual({ "new.js": "kept\n" });
  });

  it("adds and deletes empty files and ignores mode changes", () => {
    const patch = [
      "diff --git a/empty.js b/empty.js",
      "new file mode 100644",
      "index 0000000..e69de29",
      "diff --git a/blank.js b/blank.js",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "diff --git a/run.js b/run.js",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    expect(apply(patch, { "blank.js": "", "run.js": "run\n" })).toEqual({
      "empty.js": "",
      "run.js": "run\n",
    });
    expect(() => apply(patch, { "blank.js": "content\n", "run.js": "run\n" })).toThrow(
      "does not apply to blank.js",
    );
  });

  it("keeps the newline of the line that ends the file after a removal", () => {
    const patch = [
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -2 +1,0 @@",
      "-b",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    expect(apply(patch, { "a.js": "a\nb" })).toEqual({ "a.js": "a\n" });
  });

  it("rejects copies, binary changes and invalid YAML", () => {
    for (const patch of [
      "diff --git a/a.js b/b.js\ncopy from a.js\ncopy to b.js\n",
      "diff --git a/a.png b/a.png\nGIT binary patch\n",
    ])
      expect(() => projectPatches(project(patch))).toThrow("not supported");

    expect(() => projectPatches({ "pnpm-workspace.yaml": "patchedDependencies: [" })).toThrow(
      "pnpm-workspace.yaml is not valid YAML",
    );
  });

  it("declares no patches without a pnpm workspace file", () => {
    expect(projectPatches({ "package.json": "{}" })).toEqual([]);
  });
});
