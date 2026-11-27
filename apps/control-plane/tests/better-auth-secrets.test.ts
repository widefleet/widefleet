import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { authenticationOptions } from "../src/lib/server/auth-options.ts";
import { runtimeConfigurationSchema } from "../src/lib/server/config.ts";

const earlier = "synthetic-earlier-auth-secret-never-deploy";

const current = "synthetic-current-auth-secret-never-deploy";

const settings = (secrets: Record<string, string> = {}) => ({
  DATABASE_URL: "postgres://synthetic:synthetic@localhost/synthetic",
  PLATFORM_URL: "https://platform.example.test",
  APP_DOMAIN: "apps.example.test",
  BETTER_AUTH_SECRET: earlier,
  ...secrets,
});

const secretConfig = async (secrets: string) => {
  const auth = betterAuth({
    ...authenticationOptions({
      ...runtimeConfigurationSchema.parse(settings({ BETTER_AUTH_SECRETS: secrets })),
      ARTIFACT_STORAGE_PROVIDER: "r2",
    }),
    database: memoryAdapter({}),
  });

  return (await auth.$context).secretConfig;
};

describe("versioned authentication secrets", () => {
  it("encrypt under the current version and still open values written before versions", async () => {
    const before = await symmetricEncrypt({ key: earlier, data: "provider-token" });
    const key = await secretConfig(`2:${current},1:${earlier}`);
    const after = await symmetricEncrypt({ key, data: "provider-token" });

    expect(await symmetricDecrypt({ key, data: before })).toBe("provider-token");
    expect(after.startsWith("$ba$2$")).toBe(true);
    expect(await symmetricDecrypt({ key, data: after })).toBe("provider-token");
  });

  it("reject entries without a version or with a short secret", () => {
    for (const secrets of ["", current, `v2:${current}`, "2:short"])
      expect(
        runtimeConfigurationSchema.safeParse(settings({ BETTER_AUTH_SECRETS: secrets })).success,
      ).toBe(false);
  });
});
