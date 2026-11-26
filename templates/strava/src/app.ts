import { WorkerEntrypoint } from "cloudflare:workers";
import { StravaApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use the current user's Strava account through Strava's API. Each offered
 * operation is a method. Reading never asks; methods that create, change or
 * publish activities ask the user first according to their approval level.
 *
 * @remarks
 * Inputs and results keep Strava's field names. Lists take `page` and
 * `per_page`. Use the `id_str` fields of results as IDs, since some Strava IDs
 * exceed what a JSON number holds exactly.
 *
 * `getActivityStreams` takes the stream `keys` and `key_by_type: true`.
 * `createUpload` sends a FIT, TCX or GPX file as `file`, `{ mimeType, text }`
 * or `{ mimeType, base64 }`, with its `data_type`; `getUpload` reports when
 * Strava has processed it.
 *
 * @example
 * ```ts
 * const recent = await env.STRAVA.listActivities({ after: 1764547200, per_page: 10 });
 * if (recent.status === "connected") {
 *   for (const activity of recent.data) {
 *     console.log(activity.id_str, activity.name, activity.distance);
 *   }
 * }
 * ```
 */
export default class Strava extends StravaApi {
  /** Check account setup and linking. Connect the Strava account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  /** The current user's approval level, which decides when changes ask first. */
  async approvalLevel() {
    return readApprovalLevel(this.env, this.ctx.props);
  }

  /**
   * Set when the current user is asked before changes run. Asking more takes
   * effect at once; asking less asks the user to confirm.
   */
  async setApprovalLevel(input: { level: ApprovalLevel }) {
    return changeApprovalLevel("Strava", this.env, this.ctx.props, input);
  }

  override async fetch(request: Request) {
    return (
      (await saveApprovalLevel(this.env, this.ctx.props, request)) ??
      accountConnection(this.env, this.ctx.props).fetch(request)
    );
  }
}

/** Personal account controls used by Widefleet's My connections page. */
export class UserConnection extends WorkerEntrypoint<Environment, Properties> {
  async status() {
    return accountConnection(this.env, this.ctx.props).personalStatus();
  }

  async prepare(input: { completionUrl: string }) {
    return accountConnection(this.env, this.ctx.props).prepare(input);
  }

  async disconnect() {
    return accountConnection(this.env, this.ctx.props).disconnect();
  }
}
