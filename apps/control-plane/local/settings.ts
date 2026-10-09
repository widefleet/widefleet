// Local fixtures only. These identities and credentials never configure an installation.
export const platformUrl = "http://localhost:25450";

export const authority = "http://localhost:25452";

export const tenant = "00000000-0000-4000-8000-000000000001";

export const clientId = "00000000-0000-4000-8000-000000000002";

export const clientSecret = "local-demo-only";

export const adminEmail = "admin@example.test";

export const memberEmail = "member@example.test";

export const requireLocal = () => {
  if (process.env["WIDEFLEET_LOCAL_DEMO"] !== "1" || process.env["PLATFORM_URL"] !== platformUrl)
    throw new Error("This command belongs only to the isolated local demo");
};
