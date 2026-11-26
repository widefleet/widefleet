import { isDeepStrictEqual } from "node:util";
import type { SecretContext, SecretEncryption } from "../src/lib/server/secret-encryption.ts";

/**
 * Rejects a read whose context differs from the context its ciphertext was
 * written with in this process, naming both. Ciphertexts bind their context,
 * so such a read fails anyway; this reports where writer and reader disagree.
 */
export const checkSecretContexts = (encryption: SecretEncryption): SecretEncryption => {
  const written = new Map<string, SecretContext>();

  return {
    ...encryption,
    encrypt: async (context, value) => {
      const ciphertext = await encryption.encrypt(context, value);
      written.set(ciphertext, structuredClone(context));

      return ciphertext;
    },
    decrypt: async (context, ciphertext) => {
      const expected = written.get(ciphertext);

      if (expected && !isDeepStrictEqual(expected, context))
        throw new Error(
          `A secret written with ${JSON.stringify(expected)} was read with ${JSON.stringify(context)}`,
        );

      return encryption.decrypt(context, ciphertext);
    },
  };
};
