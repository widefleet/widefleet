import { WorkerEntrypoint } from "cloudflare:workers";
import { accountConnection, type Environment, type Properties } from "@platform/account-connection";
import { z } from "zod";
import {
  filePage,
  folderInput,
  folderPath,
  itemId,
  readPage,
  searchInput,
  searchPath,
} from "./files.ts";
import { provider } from "./provider.ts";

/** Browse, search and download the current user's OneDrive files. */
export default class OneDrive extends WorkerEntrypoint<Environment, Properties> {
  #connection() {
    return accountConnection(this.env, this.ctx.props, provider);
  }

  /** Check account setup and linking. Connect the Microsoft account on this app's page. */
  async connectionStatus() {
    return this.#connection().status();
  }

  /**
   * List the root folder or a folder by ID. Pass nextPageUrl as pageUrl with the same folderId to continue.
   * @example
   * await env.ONEDRIVE.listFiles({ folderId: "root" });
   */
  async listFiles(input: z.input<typeof folderInput> = {}) {
    const result = await this.#connection().request(
      `https://graph.microsoft.com${folderPath(input)}`,
    );

    if (result.status !== "connected") return result;

    return {
      status: "connected",
      ...readPage(filePage.parse(await result.response.json())),
    } as const;
  }

  /** Search filenames and content in the user's drive. Pass nextPageUrl as pageUrl with the same query to continue. */
  async searchFiles(input: z.input<typeof searchInput>) {
    const result = await this.#connection().request(
      `https://graph.microsoft.com${searchPath(input)}`,
    );

    if (result.status !== "connected") return result;

    return {
      status: "connected",
      ...readPage(filePage.parse(await result.response.json())),
    } as const;
  }

  /**
   * Get a temporary download URL for a file. Open it directly in the browser.
   * The URL grants access to this file; do not log or persist it. Request a new URL when it expires.
   */
  async getDownloadUrl(id: string) {
    const result = await this.#connection().request(
      `https://graph.microsoft.com/v1.0/me/drive/items/${itemId.parse(id)}/content`,
    );

    if (result.status !== "connected") return result;

    if (result.response.status !== 302)
      throw new Error("OneDrive did not return a download location");
    const location = new URL(z.url().parse(result.response.headers.get("location")));

    if (location.protocol !== "https:" || location.username || location.password)
      throw new Error("Invalid OneDrive download URL");

    // Download hosts vary by drive and file. Return the provider's temporary URL
    // instead of broadening this ordinary app's exact-origin network permissions.
    return { status: "connected", url: location.href } as const;
  }

  override async fetch(request: Request) {
    return this.#connection().fetch(request);
  }
}
