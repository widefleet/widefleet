import { WorkerEntrypoint } from "cloudflare:workers";
import { cloudflareLogRecords } from "./cloudflare-logs.ts";

export class CloudflareTelemetry extends WorkerEntrypoint<
  {},
  Parameters<typeof cloudflareLogRecords>[1]
> {
  override tail(events: TraceItem[]) {
    for (const event of events)
      for (const record of cloudflareLogRecords(event, this.ctx.props))
        console[record.record.level](record);
  }
}
