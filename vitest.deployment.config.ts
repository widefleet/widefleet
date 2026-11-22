import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Each runtime deployment test creates its own apps, so the suite splits into
// groups that run in parallel workers, each against a separate control plane,
// runtime container and port pair. Tests outside the named groups run in the last.
const groups = {
  runtime: [
    "rejects mismatched native binaries",
    // Expects an organization without apps, so no app test may precede it here.
    "activates a runtime without apps",
    "restores a failed runtime update",
    "confirms access through the real proxy",
    "does not retain rejected Workflow versions",
  ],
  apps: [
    "installs a release outside the workspace",
    "bundles and deploys Node ESM imports",
    "enforces browser network grants",
    "deploys and reloads, isolates preview data",
  ],
};

const pattern = (titles: string[]) =>
  titles.map((title) => title.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

const projects = [
  ...Object.entries(groups).map(([name, titles]) => ({ name, testNamePattern: pattern(titles) })),
  { name: "capabilities", testNamePattern: `^(?!.*(?:${pattern(Object.values(groups).flat())}))` },
];

export default defineConfig({
  test: {
    projects: projects.map(({ name, testNamePattern }, index) => ({
      resolve: base.resolve,
      test: {
        name: `deployment-${name}`,
        include: ["apps/control-plane/tests/runtime/deployment.test.ts"],
        testNamePattern,
        env: { RUNTIME_TEST_PORT: String(25470 + index * 2) },
      },
    })),
  },
});
