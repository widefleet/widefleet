import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Configuration } from "./config.ts";

export const readOptionalFile = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(cause).success) return null;
    throw cause;
  }
};

export const writePrivateFile = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
};

const persistentKey = async (directory: string, name: string) => {
  const path = join(directory, name);
  const existing = await readOptionalFile(path);

  if (existing !== null) return z.string().min(32).parse(existing.trim());
  const value = randomBytes(32).toString("base64url");
  await writePrivateFile(path, value);

  return value;
};

export const installationKeys = async (configuration: Configuration) => {
  if (configuration.PLATFORM_ENCRYPTION_KEY && configuration.PLATFORM_ENCRYPTION_KEY_FILE)
    throw new Error("Set either PLATFORM_ENCRYPTION_KEY or PLATFORM_ENCRYPTION_KEY_FILE");

  const encryption =
    configuration.PLATFORM_ENCRYPTION_KEY ??
    (configuration.PLATFORM_ENCRYPTION_KEY_FILE
      ? z
          .string()
          .min(32)
          .parse((await readFile(configuration.PLATFORM_ENCRYPTION_KEY_FILE, "utf8")).trim())
      : await persistentKey(configuration.PLATFORM_STATE_DIRECTORY, "encryption.key"));

  return {
    encryption,
    cookie: await persistentKey(configuration.PLATFORM_STATE_DIRECTORY, "app-cookie.key"),
    authentication:
      configuration.BETTER_AUTH_SECRET ??
      (await persistentKey(configuration.PLATFORM_STATE_DIRECTORY, "authentication.key")),
  };
};
