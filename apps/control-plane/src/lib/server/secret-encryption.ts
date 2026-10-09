import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { InvalidOperation } from "./errors.ts";

export const encryptSecret = (key: string, value: string) => symmetricEncrypt({ key, data: value });

export const decryptSecret = async (key: string, ciphertext: string) => {
  try {
    return await symmetricDecrypt({ key, data: ciphertext });
  } catch {
    throw new InvalidOperation({
      code: "BAD_REQUEST",
      message:
        "Stored credentials could not be decrypted. Restore the installation encryption key.",
    });
  }
};
