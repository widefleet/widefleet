import { WorkerEntrypoint } from "cloudflare:workers";
import { forward } from "./network.ts";
import { requireExecution, type ExecutionScope } from "./execution.ts";
import type { ParentEnvironment } from "./types.ts";

export class Gateway extends WorkerEntrypoint<
  ParentEnvironment,
  { origins: string[]; execution: ExecutionScope }
> {
  override async fetch(request: Request) {
    await requireExecution(this.env, this.ctx.props.execution);

    return forward(request, this.ctx.props.origins);
  }
}
