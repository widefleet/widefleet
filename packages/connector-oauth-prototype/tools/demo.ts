import { z } from "zod";
import { startFixture } from "../fixtures/harness.ts";

const runtime = z.enum(["celld", "workerd"]).parse(process.argv[2] ?? "workerd");

const hostname = z
  .string()
  .regex(/^[a-zA-Z0-9.-]+$/)
  .parse(process.argv[3] ?? "127.0.0.1");

const fixture = await startFixture(runtime, hostname);

console.log(`Local OAuth connector demo (${runtime}): ${fixture.origin}`);

console.log("Synthetic users and OAuth provider only. Ctrl+C removes the temporary database.");

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

await fixture.close();
