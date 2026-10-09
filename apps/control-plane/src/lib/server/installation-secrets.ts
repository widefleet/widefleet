import { secretInput, secretReference } from "@platform/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseExecutor } from "./database.ts";
import { InvalidOperation } from "./errors.ts";
import { installationSecrets } from "./schema.ts";
import { decryptSecret, encryptSecret } from "./secret-encryption.ts";

// This store belongs to the current login settings: saving settings deletes
// unreferenced rows. Resources with historical snapshots must own their ciphertexts.
export const createInstallationSecrets = (database: DatabaseExecutor, key: string) => {
  const resolve = async (input: z.infer<typeof secretInput>) => {
    if (input.type === "value") return input.value;

    const [record] = await database
      .select()
      .from(installationSecrets)
      .where(eq(installationSecrets.id, input.id));

    if (!record)
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message: "The referenced secret does not exist",
      });

    return decryptSecret(key, record.ciphertext);
  };

  const save = async (
    executor: DatabaseExecutor,
    input: z.infer<typeof secretInput>,
  ): Promise<z.infer<typeof secretReference>> => {
    if (input.type === "stored") {
      const [record] = await executor
        .select({ id: installationSecrets.id })
        .from(installationSecrets)
        .where(eq(installationSecrets.id, input.id));

      if (!record)
        throw new InvalidOperation({
          code: "BAD_REQUEST",
          message: "The referenced secret no longer exists. Reload settings before saving.",
        });

      return input;
    }

    const ciphertext = await encryptSecret(key, input.value);
    const id = crypto.randomUUID();
    await executor.insert(installationSecrets).values({ id, ciphertext });

    return { type: "stored", id };
  };

  return { resolve, save };
};
