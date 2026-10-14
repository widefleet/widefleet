import { readCloudflareConfiguration, type CloudflareBindings } from "./cloudflare-config.ts";
import { createDatabase } from "./database.ts";

export const withCloudflareDatabase = async <T>(
  bindings: CloudflareBindings,
  operation: (database: ReturnType<typeof createDatabase>) => Promise<T>,
) => {
  const database = createDatabase(readCloudflareConfiguration(bindings), 1);
  const disconnected: Promise<void>[] = [];
  // Pool.end() resolves before idle clients finish closing their sockets. Release
  // connections before a Workflow retry consumes another Workers connection slot.
  database.db.$client.on("connect", (client) => {
    disconnected.push(new Promise<void>((resolve) => client.once("end", resolve)));
  });

  try {
    return await operation(database);
  } finally {
    await database.close();
    await Promise.all(disconnected);
  }
};
