import { memorySkillFiles, SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import type { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";

export const mcpInstructions = [
  "Widefleet builds, deploys and runs your organization's internal apps,",
  "which connect company systems and work tools such as issue trackers, email, CRM and analytics.",
  "Search it before saying a tool or service is not connected.",
  "Use the APIs of running apps by finding methods with search, reading them with describe, then using call or execute.",
  "Apps are built and deployed with the Widefleet CLI in your shell.",
  "If the CLI has no session, run the command that cli_login returns instead of asking the user to sign in.",
  "Before building, changing or deploying an app, read the widefleet skill",
  '(the skills tool with name "widefleet", or skill://widefleet/SKILL.md).',
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
