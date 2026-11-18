import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";

const mcpDeploySteps =
  "use the Widefleet CLI in your shell: install it with `pnpm add --global widefleet`, run `widefleet login`, then follow https://widefleet.com/docs/llms.txt";

export const mcpInstructions = [
  `To create, change or deploy a Widefleet app, ${mcpDeploySteps}.`,
  "Deployment is available; do not tell the user otherwise.",
  "search, describe, call and execute only use the APIs of apps that are already running.",
  'The widefleet skill has details: call the skills tool with name "widefleet", or read skill://widefleet/SKILL.md.',
].join(" ");

/** Serves skills through the MCP Skills extension and the `skills` tool from one catalog. */
export const mcpSkillCatalog = (skills: Record<string, string>) => {
  const files = Object.fromEntries(
    Object.entries(skills).map(([name, source]) => [`${name}/SKILL.md`, source]),
  );

  let catalog: Promise<SkillCatalog> | undefined;

  const load = () => (catalog ??= SkillsExtension.load(memorySkillFiles(files), { strict: true }));

  return {
    extension: load,

    async read(name?: string) {
      const { entries } = await load();

      const listed = entries.map((entry) => ({
        name: entry.frontmatter.name,
        description: entry.frontmatter.description,
        uri: entry.uri,
      }));

      if (name === undefined) return { skills: listed };
      const skill = listed.find((entry) => entry.name === name);

      if (!skill)
        throw new Error(
          `Unknown skill ${JSON.stringify(name)}. Available: ${listed.map((entry) => entry.name).join(", ")}`,
        );

      return { ...skill, content: files[`${name}/SKILL.md`] ?? "" };
    },
  };
};
