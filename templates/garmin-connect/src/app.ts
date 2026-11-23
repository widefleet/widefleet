import { WorkerEntrypoint } from "cloudflare:workers";
import { GarminConnectApi } from "./api.ts";
import { keyConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Read the current user's own Garmin Connect data through Garmin's Personal
 * API: activities and their files, daily summaries, sleep, heart rate, HRV,
 * Body Battery, fitness, weight, nutrition and women's health. Each offered
 * operation is a method; every method only reads.
 */
export default class GarminConnect extends GarminConnectApi {
  /** Check whether the user saved a Personal API key Garmin accepts. Save it on this app's page. */
  async connectionStatus() {
    return keyConnection(this.env, this.ctx.props).status();
  }

  override async fetch(request: Request) {
    return keyConnection(this.env, this.ctx.props).fetch(request);
  }
}

/** Personal account controls used by Widefleet's My connections page. */
export class UserConnection extends WorkerEntrypoint<Environment, Properties> {
  async status() {
    return keyConnection(this.env, this.ctx.props).personalStatus();
  }

  async prepare(input: { completionUrl: string }) {
    return keyConnection(this.env, this.ctx.props).prepare(input);
  }

  async disconnect() {
    return keyConnection(this.env, this.ctx.props).disconnect();
  }
}
