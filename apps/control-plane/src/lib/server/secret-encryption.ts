import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { InvalidOperation } from "./errors.ts";

/**
 * Names the stored value a ciphertext protects. Each kind carries exactly the
 * fields that every writer and reader of that value knows, so encryption and
 * decryption always receive the same context.
 */
export type SecretContext =
  /** A value in `apps.secrets`. */
  | { kind: "app-secret"; organizationId: string; appId: string; name: string }
  /** `organization_settings.directory_secret`. */
  | { kind: "directory-client-secret"; organizationId: string }
  /** `organization_settings.app_client_secret`. */
  | { kind: "app-login-client-secret"; organizationId: string }
  /** The client secret of a pre-plugin `organization_settings.settings.identity`. */
  | { kind: "legacy-sso-client-secret"; organizationId: string }
  /**
   * `sso_provider.oidc_config` or `sso_provider.saml_config`. Better Auth's
   * field transforms receive only the value, so this context cannot name the
   * provider or its organization.
   */
  | { kind: "sso-provider-config"; field: "oidcConfig" | "samlConfig" };

/**
 * Encrypts the customer secrets that the control plane stores. Callers name
 * what they protect and never handle key material.
 */
export const createSecretEncryption = ({ legacyKey }: { legacyKey: string }) => ({
  // The context is not yet bound to the ciphertext. Callers already pass it, so
  // binding it later changes only this module.
  encrypt: async (_context: SecretContext, value: string) =>
    symmetricEncrypt({ key: legacyKey, data: value }),
  decrypt: async (_context: SecretContext, ciphertext: string) => {
    try {
      return await symmetricDecrypt({ key: legacyKey, data: ciphertext });
    } catch {
      throw new InvalidOperation({
        code: "BAD_REQUEST",
        message:
          "Stored credentials could not be decrypted. Restore the installation encryption key.",
      });
    }
  },
});

export type SecretEncryption = ReturnType<typeof createSecretEncryption>;
