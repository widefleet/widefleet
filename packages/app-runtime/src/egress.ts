import { WorkerEntrypoint } from "cloudflare:workers";
import { forward } from "./network.ts";
import { requireExecution } from "./execution.ts";
import type { BindingProperties, ParentEnvironment } from "./types.ts";

export class Gateway extends WorkerEntrypoint<
  ParentEnvironment,
  { origins: string[]; identity: BindingProperties["identity"] }
> {
  override async fetch(request: Request) {
    await requireExecution(this.env, this.ctx.props.identity);

    return forward(request, this.ctx.props.origins);
  }
}
