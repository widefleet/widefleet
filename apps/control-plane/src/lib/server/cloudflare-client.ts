import Cloudflare from "cloudflare";
import { z } from "zod";

export class CloudflareApiError extends Error {
  readonly status: number;

  constructor(status: number, operation = "provisioning request", codes: number[] = []) {
    // API messages and connection causes can contain credentials or uploaded source.
    super(
      `Cloudflare ${operation} failed (HTTP ${status}${codes.length ? `; codes ${codes.join(", ")}` : ""})`,
    );
    this.name = "CloudflareApiError";
    this.status = status;
  }
}

export const cloudflareCall = async <T>(operation: string, run: () => Promise<T>) => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Cloudflare.APIError) {
      if (error.status !== undefined) {
        const parsed = z.array(z.object({ code: z.number().int() })).safeParse(error.errors);
        throw new CloudflareApiError(
          z.number().int().parse(error.status),
          operation,
          parsed.success ? parsed.data.map(({ code }) => code) : [],
        );
      }

      throw new Error(
        `Cloudflare ${operation} failed (${error instanceof Cloudflare.APIConnectionTimeoutError ? "timeout" : "connection error"})`,
      );
    }

    throw error;
  }
};

export const createCloudflareClient = (token: string, transport: typeof fetch = fetch) =>
  new Cloudflare({
    apiToken: token,
    apiKey: null,
    apiEmail: null,
    fetch: transport,
    fetchOptions: { redirect: "manual" },
    // Workflow checkpoints own retries, including recovery after lost write responses.
    maxRetries: 0,
    timeout: 30_000,
    logLevel: "off",
  });
