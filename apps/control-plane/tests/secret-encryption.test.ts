import { symmetricDecrypt } from "better-auth/crypto";
import { expect, it } from "vitest";
import { createSecretEncryption } from "../src/lib/server/secret-encryption.ts";

const legacyKey = "synthetic-legacy-installation-key-for-tests";

const context = { kind: "directory-client-secret", organizationId: "widefleet" } as const;

it("decrypts ciphertexts that earlier releases stored", async () => {
  // Recorded from better-auth's symmetricEncrypt with the synthetic key above.
  const stored =
    "04170b74ec840be7258e5c66a39a6a3455ee568a0ea14a8df2866f47bf919593d5bf7849c95bf27ecb86c01f03052ca9329cab0882bbedc2";

  expect(await createSecretEncryption({ legacyKey }).decrypt(context, stored)).toBe(
    "synthetic secret",
  );
});

it("writes ciphertexts that earlier releases can read", async () => {
  const encryption = createSecretEncryption({ legacyKey });
  const ciphertext = await encryption.encrypt(context, "synthetic secret");

  expect(ciphertext).not.toContain("synthetic secret");
  expect(await symmetricDecrypt({ key: legacyKey, data: ciphertext })).toBe("synthetic secret");
  expect(await encryption.decrypt(context, ciphertext)).toBe("synthetic secret");
});

it("asks for the installation key when a ciphertext does not decrypt", async () => {
  const ciphertext = await createSecretEncryption({ legacyKey }).encrypt(context, "value");

  await expect(
    createSecretEncryption({ legacyKey: "another-synthetic-installation-key" }).decrypt(
      context,
      ciphertext,
    ),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Stored credentials could not be decrypted. Restore the installation encryption key.",
  });
});
