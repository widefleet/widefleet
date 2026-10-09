import { WorkerEntrypoint } from "cloudflare:workers";

/** @extends {WorkerEntrypoint<Record<string, string | undefined>>} */
export default class ConnectorSecrets extends WorkerEntrypoint {
  /** @param {string} name */
  async get(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new Error("Invalid connector secret name");
    }

    const value = this.env[name];

    if (!Object.hasOwn(this.env, name) || value === undefined) {
      throw new Error(`Connector secret ${name} is not configured`);
    }

    return value;
  }
}
