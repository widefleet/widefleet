import {
  appTemplate,
  appTemplateCatalog,
  appTemplateSummary,
  templateId,
} from "@platform/contracts";
import { Result } from "better-result";
import { parse } from "yaml";
import { z } from "zod";
import type { Principal } from "./identity.ts";
import type { Configuration } from "./config.ts";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";

const repository = "https://github.com/widefleet/widefleet/tree/main/templates";

const directory = "https://api.github.com/repos/widefleet/widefleet/contents/templates?ref=main";

const files = "https://raw.githubusercontent.com/widefleet/widefleet/main/templates";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const cli = (principal: Principal, configuration: Pick<Configuration, "PLATFORM_URL">) =>
  `widefleet --url ${shellQuote(configuration.PLATFORM_URL)} --organization ${shellQuote(principal.application.organizationId)}`;

const loadTemplate = async (id: string) => {
  const response = await fetch(`${files}/${id}/template.md`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404) return null;

  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const text = await response.text();
  const parts = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(text);

  if (!parts) throw new Error(`Missing frontmatter in ${id}/template.md`);
  const metadata = appTemplateSummary.omit({ id: true }).parse(parse(parts[1] ?? ""));

  return { id, ...metadata, source: `${repository}/${id}`, markdown: parts[2] ?? "" };
};

export const templateCatalog = (
  principal: Principal,
  configuration: Pick<Configuration, "PLATFORM_URL" | "GITHUB_TOKEN">,
  search = "",
) =>
  Result.tryPromise({
    try: async () => {
      const headers = new Headers({
        accept: "application/vnd.github+json",
        "user-agent": "Widefleet",
      });

      if (configuration.GITHUB_TOKEN)
        headers.set("authorization", `Bearer ${configuration.GITHUB_TOKEN}`);

      const response = await fetch(directory, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

      const entries = z
        .array(z.object({ name: z.string(), type: z.string() }))
        .parse(await response.json());

      const templates = await Promise.all(
        entries.flatMap((entry) =>
          entry.type === "dir" && templateId.safeParse(entry.name).success
            ? [loadTemplate(entry.name)]
            : [],
        ),
      );

      const term = search.trim().toLowerCase();

      return appTemplateCatalog.parse({
        templates: templates.flatMap((template) =>
          template && `${template.name} ${template.description}`.toLowerCase().includes(term)
            ? [{ id: template.id, name: template.name, description: template.description }]
            : [],
        ),
        createPrompt: `Help me create an app on Widefleet. Ask what it should do. Read https://widefleet.com/SKILL.md. Use ${cli(principal, configuration)} for this installation and organization. Check existing apps and templates, then build, test and deploy the app and help me complete its setup.`,
      });
    },
    catch: (cause) =>
      new StorageUnavailable({ message: "App templates are unavailable. Try again later.", cause }),
  });

export const readTemplate = (
  principal: Principal,
  configuration: Pick<Configuration, "PLATFORM_URL">,
  id: string,
) =>
  Result.gen(async function* () {
    const template = yield* Result.await(
      Result.tryPromise({
        try: () => loadTemplate(id),
        catch: (cause) =>
          new StorageUnavailable({
            message: "App templates are unavailable. Try again later.",
            cause,
          }),
      }),
    );

    if (!template)
      return yield* new InvalidOperation({ code: "NOT_FOUND", message: "App template not found" });

    return Result.ok(
      appTemplate.parse({
        ...template,
        prompt: `Set up the ${template.name} app on Widefleet. Read https://widefleet.com/SKILL.md, then run ${cli(principal, configuration)} catalog templates show ${id} and follow its template instructions. Reuse a suitable existing app where possible. Help me finish setup and report its URL and any steps that still need my attention.`,
      }),
    );
  });
