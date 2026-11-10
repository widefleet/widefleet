import { z } from "zod";

export const repositoryName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .refine((value) => value !== "." && value !== "..", "Invalid repository name");

export const ownerName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const repositoryInput = z.object({ owner: ownerName, repository: repositoryName });

export const pageInput = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  perPage: z.number().int().min(1).max(100).default(30),
});

export const issuesInput = repositoryInput.extend({
  ...pageInput.shape,
  state: z.enum(["open", "closed", "all"]).default("open"),
});

export const fileInput = repositoryInput.extend({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        value.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
      "Use a file path relative to the repository root",
    ),
  ref: z.string().min(1).max(1024).optional(),
});

export const repository = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  html_url: z.url(),
  default_branch: z.string(),
});

export const issue = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.url(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});

export const repositoryPath = (input: z.infer<typeof repositoryInput>) =>
  `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`;

export const repositoriesPath = (input: z.input<typeof pageInput>) => {
  const options = pageInput.parse(input);

  return `/user/repos?${new URLSearchParams({
    page: String(options.page),
    per_page: String(options.perPage),
    sort: "full_name",
  }).toString()}`;
};

export const issuesPath = (input: z.input<typeof issuesInput>) => {
  const options = issuesInput.parse(input);

  return `${repositoryPath(options)}/issues?${new URLSearchParams({
    page: String(options.page),
    per_page: String(options.perPage),
    state: options.state,
  }).toString()}`;
};

export const filePath = (input: z.input<typeof fileInput>) => {
  const options = fileInput.parse(input);
  const path = options.path.split("/").map(encodeURIComponent).join("/");

  return `${repositoryPath(options)}/contents/${path}${options.ref ? `?${new URLSearchParams({ ref: options.ref }).toString()}` : ""}`;
};

// GitHub's issues endpoint includes pull requests. Preserve server pagination
// even when a page contains only PRs and consequently returns no issues.
export const readIssues = (value: z.infer<typeof issue>[]) =>
  value.flatMap(({ pull_request, ...entry }) => (pull_request === undefined ? [entry] : []));

export const hasNextPage = (headers: Headers) => /;\s*rel="next"/.test(headers.get("link") ?? "");
