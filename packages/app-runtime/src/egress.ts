import { WorkerEntrypoint } from "cloudflare:workers";
import { forward } from "./network.ts";

export class Gateway extends WorkerEntrypoint<{}, { origins: string[] }> {
  override fetch(request: Request) {
    return forward(request, this.ctx.props.origins);
  }
}
