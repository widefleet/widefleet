import { WorkerEntrypoint } from "cloudflare:workers";
import {
  accountConnection,
  readBytes,
  type Environment,
  type Properties,
} from "@platform/account-connection";
import { z } from "zod";
import {
  fileInput,
  filePath,
  hasNextPage,
  issue,
  issuesInput,
  issuesPath,
  pageInput,
  readIssues,
  repositoriesPath,
  repository,
} from "./repositories.ts";
import { provider } from "./provider.ts";

/** Read repositories, issues and files accessible to the current user's GitHub connection. */
export default class GitHub extends WorkerEntrypoint<Environment, Properties> {
  #connection() {
    return accountConnection(this.env, this.ctx.props, provider);
  }

  #request(path: string, raw = false) {
    return this.#connection().request(
      `https://api.github.com${path}`,
      new Headers({
        accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "user-agent": "Widefleet-GitHub",
        "x-github-api-version": "2022-11-28",
      }),
    );
  }

  /** Check account setup and linking. Connect the GitHub account on this app's page. */
  async connectionStatus() {
    return this.#connection().status();
  }

  /** List repositories visible to the connected account. Use nextPage to continue. */
  async listRepositories(input: z.input<typeof pageInput> = {}) {
    const options = pageInput.parse(input);
    const result = await this.#request(repositoriesPath(options));

    if (result.status !== "connected") return result;

    return {
      status: "connected",
      repositories: z.array(repository).parse(await result.response.json()),
      nextPage: hasNextPage(result.response.headers) ? options.page + 1 : null,
    } as const;
  }

  /** List repository issues, excluding pull requests. A page can be empty and still have a nextPage. */
  async listIssues(input: z.input<typeof issuesInput>) {
    const options = issuesInput.parse(input);
    const result = await this.#request(issuesPath(options));

    if (result.status !== "connected") return result;

    return {
      status: "connected",
      issues: readIssues(z.array(issue).parse(await result.response.json())),
      nextPage: hasNextPage(result.response.headers) ? options.page + 1 : null,
    } as const;
  }

  /**
   * Read a repository file as bytes, up to 8 MiB. ref may be a branch, tag or commit SHA.
   * @example
   * await env.GITHUB.readFile({ owner: "example", repository: "project", path: "README.md" });
   */
  async readFile(input: z.input<typeof fileInput>) {
    const result = await this.#request(filePath(input), true);

    if (result.status !== "connected") return result;

    if (!result.response.ok) throw new Error("GitHub did not return file content");
    const body = await readBytes(result.response);

    if (body.status !== "connected") return body;

    return {
      ...body,
      contentType: result.response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  override async fetch(request: Request) {
    return this.#connection().fetch(request);
  }
}
