import { WorkerEntrypoint } from "cloudflare:workers";
import { cloudflareLogRecords } from "./cloudflare-logs.ts";

export class CloudflareTelemetry extends WorkerEntrypoint<
  {},
  { appId: string; deploymentId: string; buildId: string | null }
> {
  override tail(events: TraceItem[]) {
    for (const event of events)
      for (const record of cloudflareLogRecords(event, this.ctx.props))
        console[record.record.level](record);
  }
}
