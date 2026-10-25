import { WorkerEntrypoint } from "cloudflare:workers";
import { runtimeExtension } from "#runtime-extension";
import type { WorkerIdentity } from "./runtime-extension.ts";
import type { ParentEnvironment } from "./types.ts";

export class RuntimeObserver extends WorkerEntrypoint<ParentEnvironment, WorkerIdentity> {
  override async tail(events: TraceItem[]) {
    await runtimeExtension.tail?.(events, this.ctx.props, (name, schema) =>
      schema.parse(this.env[name]),
    );
  }
}
