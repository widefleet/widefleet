import { isDeepStrictEqual } from "node:util";
import type { R2Bucket, Workflow } from "@cloudflare/workers-types";
import type { z } from "zod";
import { InvalidOperation } from "./errors.ts";

// Both deployment and management operations bind retries to one immutable input.
export const acceptCloudflareWorkflow = async <
  T extends { id: string; appId: string; createdAt: string },
>(
  storage: R2Bucket,
  workflow: Pick<Workflow<T>, "create" | "get">,
  input: T,
  commandSchema: z.ZodType<T>,
) => {
  const key = `apps/${input.appId}/commands/${input.id}.json`;

  const written = await storage.put(key, JSON.stringify(input), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });

  let command = input;

  if (!written) {
    const existing = await storage.get(key);

    if (!existing) throw new Error("The immutable operation input is missing");
    command = commandSchema.parse(await existing.json());
    const { createdAt: _inputTime, ...requested } = input;
    const { createdAt: _storedTime, ...stored } = command;

    if (!isDeepStrictEqual(requested, stored))
      throw new InvalidOperation({
        code: "CONFLICT",
        message: "The request ID already refers to another operation",
      });
  }

  try {
    await workflow.create({ id: command.id, params: command });
  } catch (error) {
    const instance = await workflow.get(command.id);

    if ((await instance.status()).status === "unknown") throw error;
  }

  return command;
};
