import { WorkerEntrypoint } from "cloudflare:workers";
import { appKeys, type KeyData, type KeyOwner } from "./keys.ts";
import type { ParentEnvironment } from "./types.ts";

export class AppKeys extends WorkerEntrypoint<ParentEnvironment, KeyOwner> {
  encrypt(name: string, data: KeyData, additionalData?: KeyData) {
    return appKeys(this.env, this.ctx.props).encrypt(name, data, additionalData);
  }

  decrypt(name: string, ciphertext: string, additionalData?: KeyData) {
    return appKeys(this.env, this.ctx.props).decrypt(name, ciphertext, additionalData);
  }

  sign(name: string, data: KeyData) {
    return appKeys(this.env, this.ctx.props).sign(name, data);
  }

  verify(name: string, data: KeyData, signature: string) {
    return appKeys(this.env, this.ctx.props).verify(name, data, signature);
  }
}
