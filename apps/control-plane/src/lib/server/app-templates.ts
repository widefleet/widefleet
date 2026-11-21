import {
  appDeclaration,
  appTemplate,
  appTemplateCatalog,
  appTemplateSummary,
  templateId,
} from "@platform/contracts";
import { Result } from "better-result";
import { parseJsonc } from "@platform/contracts/jsonc";
import { parse } from "yaml";
import { z } from "zod";
import type { Principal } from "./identity.ts";
import type { Configuration } from "./config.ts";
import { InvalidOperation, StorageUnavailable } from "./errors.ts";
import { iconPaths, maxIconBytes } from "./app-icons.ts";
import { declaredAssets } from "./template-project.ts";
import { readBody } from "./upload-body.ts";

const maxWranglerBytes = 1024 * 1024;

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

// The origins a template declares in widefleet.jsonc, which an install grants.
const loadNetwork = async (id: string) => {
  const response = await fetch(`${files}/${id}/widefleet.jsonc`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404) return undefined;

  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const network = appDeclaration.parse(parseJsonc(await response.text())).network;

  return network && { backend: network.backend, browser: network.browser };
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
  installable: boolean,
) =>
  Result.gen(async function* () {
    const template = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const [template, network] = await Promise.all([loadTemplate(id), loadNetwork(id)]);

          return template && { ...template, network };
        },
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
        installable,
      }),
    );
  });

const api = "https://api.github.com/repos/widefleet/widefleet";

const raw = "https://raw.githubusercontent.com/widefleet/widefleet";

const githubHeaders = (configuration: Pick<Configuration, "GITHUB_TOKEN">) => {
  const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "Widefleet" });

  if (configuration.GITHUB_TOKEN)
    headers.set("authorization", `Bearer ${configuration.GITHUB_TOKEN}`);

  return headers;
};

const github = async <T>(url: string, schema: z.ZodType<T>, headers: Headers) => {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });

  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

  return schema.parse(await response.json());
};

// Tests, in test directories or beside the code, are not part of the deployed app.
const testFile = /(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * A template's files at the current commit, by path relative to its
 * directory, without tests. Static assets can be binary, so files are bytes.
 */
export const templateSources = (configuration: Pick<Configuration, "GITHUB_TOKEN">, id: string) =>
  Result.gen(async function* () {
    const headers = githubHeaders(configuration);

    const tree = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const { sha } = await github(
            `${api}/commits/main`,
            z.object({ sha: z.string() }),
            headers,
          );

          const listing = await github(
            `${api}/git/trees/${sha}?recursive=1`,
            z.object({
              truncated: z.boolean().optional(),
              tree: z.array(z.object({ path: z.string(), type: z.string() })),
            }),
            headers,
          );

          if (listing.truncated) throw new Error("GitHub truncated the repository tree");

          return { commit: sha, entries: listing.tree };
        },
        catch: (cause) =>
          new StorageUnavailable({
            message: "App templates are unavailable. Try again later.",
            cause,
          }),
      }),
    );

    const prefix = `templates/${id}/`;

    const paths = tree.entries.flatMap((entry) =>
      entry.type === "blob" && entry.path.startsWith(prefix)
        ? [entry.path.slice(prefix.length)]
        : [],
    );

    if (!paths.includes("template.md"))
      return yield* new InvalidOperation({ code: "NOT_FOUND", message: "App template not found" });

    const files = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          Object.fromEntries(
            await Promise.all(
              paths
                .filter((path) => !testFile.test(path))
                .map(async (path) => {
                  const response = await fetch(`${raw}/${tree.commit}/${prefix}${path}`, {
                    signal: AbortSignal.timeout(10_000),
                  });

                  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

                  return [path, new Uint8Array(await response.arrayBuffer())] as const;
                }),
            ),
          ),
        catch: (cause) =>
          new StorageUnavailable({
            message: "App templates are unavailable. Try again later.",
            cause,
          }),
      }),
    );

    return Result.ok({ commit: tree.commit, files });
  });

/**
 * A template's favicon from the static assets on the main branch, for the
 * catalog. It is read as a deployed app's icon would be, by its root path.
 */
export const readTemplateIcon = (id: string) =>
  Result.gen(async function* () {
    const missing = () =>
      new InvalidOperation({ code: "NOT_FOUND", message: "Template icon not found" });

    const unavailable = (cause: unknown) =>
      new StorageUnavailable({ message: "App templates are unavailable. Try again later.", cause });

    // A file above the limit is unusable, so it stops downloading at the limit.
    const read = (path: string, limit: number) =>
      Result.tryPromise({
        try: async () => {
          const response = await fetch(`${files}/${id}/${path}`, {
            signal: AbortSignal.timeout(10_000),
          });

          if (response.ok) return (await readBody(response, limit)).unwrapOr(null);
          await response.body?.cancel();

          if (response.status === 404) return null;

          throw new Error(`GitHub returned HTTP ${response.status}`);
        },
        catch: unavailable,
      });

    // The installer's precedence for the Wrangler file.
    const wrangler =
      (yield* Result.await(read("wrangler.jsonc", maxWranglerBytes))) ??
      (yield* Result.await(read("wrangler.json", maxWranglerBytes)));

    const assets = declaredAssets(
      wrangler ? new TextDecoder().decode(wrangler) : undefined,
    ).unwrapOr(undefined);

    if (!assets) return yield* missing();

    for (const [path, contentType] of iconPaths) {
      const bytes = yield* Result.await(read(`${assets.directory}${path}`, maxIconBytes));

      if (bytes && bytes.byteLength > 0) return Result.ok({ bytes, contentType });
    }

    return yield* missing();
  });
