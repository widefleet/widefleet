import dns from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";

const path = z.string().parse(process.env["WIDEFLEET_TEST_DNS_FILE"]);

// Only this test-server process uses the synthetic DNS zone. Product builds do not import it.
dns.resolveTxt = async (name) => {
  const records = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(path, "utf8")));
  const value = records[name];

  if (!value) throw new Error("Synthetic TXT record not found");

  return [[value]];
};

// Unpublished test domains have no website. Keep address lookups synthetic too.
const noAddress = async () => {
  throw Object.assign(new Error("Synthetic address record not found"), { code: "ENODATA" });
};

dns.resolve4 = noAddress;

dns.resolve6 = noAddress;

syncBuiltinESMExports();
