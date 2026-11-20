import { WorkerEntrypoint } from "cloudflare:workers";
import { appKeys, type KeyData } from "./keys.ts";
import type { ParentEnvironment } from "./types.ts";

export class AppKeys extends WorkerEntrypoint<ParentEnvironment, { appId: string }> {
  encrypt(name: string, data: KeyData, additionalData?: KeyData) {
    return appKeys(this.env, this.ctx.props.appId).encrypt(name, data, additionalData);
  }

  decrypt(name: string, ciphertext: string, additionalData?: KeyData) {
    return appKeys(this.env, this.ctx.props.appId).decrypt(name, ciphertext, additionalData);
  }

  sign(name: string, data: KeyData) {
    return appKeys(this.env, this.ctx.props.appId).sign(name, data);
  }

  verify(name: string, data: KeyData, signature: string) {
    return appKeys(this.env, this.ctx.props.appId).verify(name, data, signature);
  }
}
