import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";

export const mcpInstructions = [
  "Widefleet runs your organization's internal apps.",
  "Use search, describe, call and execute to use the APIs of running apps.",
  "These tools cannot create, change or deploy apps.",
  "Before building, changing or deploying an app, read the widefleet skill",
  "(skill://widefleet/SKILL.md, or the skills tool) and follow it.",
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
