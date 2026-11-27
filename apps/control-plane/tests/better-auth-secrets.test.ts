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
  it("open values from before versions and from earlier versions, and encrypt under the current one", async () => {
    const unversioned = await symmetricEncrypt({ key: earlier, data: "provider-token" });

    const versioned = await symmetricEncrypt({
      key: await secretConfig(`1:${earlier}`),
      data: "provider-token",
    });

    const key = await secretConfig(`2:${current},1:${earlier}`);
    const encrypted = await symmetricEncrypt({ key, data: "provider-token" });

    expect(await symmetricDecrypt({ key, data: unversioned })).toBe("provider-token");
    expect(versioned.startsWith("$ba$1$")).toBe(true);
    expect(await symmetricDecrypt({ key, data: versioned })).toBe("provider-token");
    expect(encrypted.startsWith("$ba$2$")).toBe(true);
    expect(await symmetricDecrypt({ key, data: encrypted })).toBe("provider-token");
  });

  it("read entries as Better Auth does and reject what it rejects", () => {
    expect(
      runtimeConfigurationSchema.parse(
        settings({ BETTER_AUTH_SECRETS: ` 2 : ${current} , 1:${earlier}` }),
      ).BETTER_AUTH_SECRETS,
    ).toEqual([
      { version: 2, value: current },
      { version: 1, value: earlier },
    ]);
    expect(
      runtimeConfigurationSchema.parse(settings({ BETTER_AUTH_SECRETS: "" })).BETTER_AUTH_SECRETS,
    ).toBeUndefined();

    for (const secrets of [
      current,
      `v2:${current}`,
      "2:short",
      `2:${current},2:${earlier}`,
      `${"9".repeat(22)}:${current}`,
      `2:${current},`,
      " ",
    ])
      expect(
        runtimeConfigurationSchema.safeParse(settings({ BETTER_AUTH_SECRETS: secrets })).success,
      ).toBe(false);
  });
});
