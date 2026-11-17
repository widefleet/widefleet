import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const execute = promisify(execFile);

const workflow = z.object({
  on: z.record(z.string(), z.unknown()),
  jobs: z.record(
    z.string(),
    z.object({
      uses: z.string().optional(),
      if: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      with: z.record(z.string(), z.unknown()).optional(),
      permissions: z.record(z.string(), z.string()).optional(),
      steps: z
        .array(
          z.object({
            uses: z.string().optional(),
            run: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

const load = async (name: string) =>
  workflow.parse(
    parse(
      await readFile(
        new URL(`../../../../.github/workflows/${name}.yaml`, import.meta.url),
        "utf8",
      ),
    ),
  );

const main = await load("publish-cli");

const checks = await load("check");

const suites = await load("check-suites");

it("builds native CLI packages once per main push while preserving PR checks", () => {
  expect(checks.on["push"]).toBeUndefined();
  expect(checks.on["pull_request"]).toBeDefined();
  expect(main.on["push"]).toEqual({ branches: ["main"], tags: ["v*"] });
  expect(main.on["pull_request"]).toBeUndefined();
  expect(main.jobs["main-checks"]?.uses).toBe("./.github/workflows/check-suites.yaml");
  expect(main.jobs["main-checks"]?.needs).toBe("main-changes");
  expect(main.jobs["build-canary"]).toBeUndefined();
  expect(checks.jobs["pull-request-checks"]?.uses).toBe("./.github/workflows/check-suites.yaml");
  expect(checks.jobs["source-and-integration"]?.needs).toBe("pull-request-checks");
  expect(suites.jobs["cli-platforms"]?.uses).toBe("./.github/workflows/cli-platforms.yaml");
  expect(suites.jobs["cli-platforms"]?.if).toBeUndefined();
  expect(suites.jobs["cli-platforms"]?.with?.["canary"]).toBe(true);
});

it("always tests native packages but allows service suites to skip packaged Markdown changes", () => {
  expect(main.jobs["main-checks"]?.if).toBe(
    "needs.main-changes.outputs.checks == 'true' || needs.main-changes.outputs.canary == 'true'",
  );
  expect(main.jobs["main-checks"]?.with?.["full-checks"]).toBe(
    "${{ needs.main-changes.outputs.checks == 'true' }}",
  );
  expect(suites.on["workflow_call"]).toMatchObject({
    inputs: { "full-checks": { type: "boolean", default: true } },
  });
  expect(suites.jobs["checks"]?.if).toBe("inputs.full-checks");
});

it("publishes only the tested artifacts from the same main workflow run", () => {
  const publisher = main.jobs["publish-canary"];
  expect(publisher?.needs).toEqual(["main-changes", "main-checks", "source-and-integration"]);
  expect(publisher?.if).toBe(
    "github.repository == 'widefleet/widefleet' && github.ref == 'refs/heads/main' && needs.main-changes.outputs.canary == 'true'",
  );

  const download = publisher?.steps?.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );

  expect(download?.with).toEqual({
    pattern: "cli-*",
    "merge-multiple": true,
    path: "${{ env.CLI_RELEASE_DIRECTORY }}",
  });
  expect(publisher?.permissions).toEqual({ contents: "read", "id-token": "write" });
  expect(
    publisher?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"))?.with,
  ).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
  expect(publisher?.steps?.some((step) => step.run?.includes("tools/prepare-cli-canary.py"))).toBe(
    true,
  );
  // Stable tags retain their independent builds and release prerequisites.
  expect(main.jobs["prepare"]?.if).toContain("startsWith(github.ref, 'refs/tags/v')");
  expect(main.jobs["build-native"]?.needs).toBe("prepare");
  expect(main.jobs["publish"]?.needs).toEqual(["prepare", "build", "build-native", "build-images"]);
});

it.each([
  ["true", "true", "success", "success", true],
  ["true", "false", "success", "success", true],
  ["false", "true", "success", "success", true],
  ["false", "false", "skipped", "success", true],
  ["true", "true", "failure", "success", false],
  ["true", "true", "cancelled", "success", false],
  ["true", "true", "abandoned", "success", false],
  ["true", "false", "skipped", "success", false],
  ["false", "true", "skipped", "success", false],
  ["false", "false", "skipped", "failure", false],
  ["", "", "skipped", "success", false],
])(
  "checks main results: suites=%s, canary=%s, tests=%s, selection=%s",
  async (runChecks, canary, result, selection, passes) => {
    const gate = main.jobs["source-and-integration"]?.steps?.find((step) => step.run)?.run;

    if (!gate) throw new Error("Missing main check gate");

    const run = execute("bash", ["-e", "-c", gate], {
      env: {
        ...process.env,
        CHANGES_RESULT: selection,
        CHECKS_RESULT: result,
        RUN_CHECKS: runChecks,
        CANARY: canary,
      },
    });

    if (passes) await expect(run).resolves.toMatchObject({ stdout: "" });
    else await expect(run).rejects.toThrow();
  },
);
