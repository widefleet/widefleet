import { describe, expect, it } from "vitest";
import { UnsecuredJWT, type JWTPayload } from "jose";
import { providerEmailDomain } from "../src/lib/server/social-sign-in.ts";

// Saved ID tokens come from the provider's token endpoint; only their claims matter here.
const token = (claims: JWTPayload) => new UnsecuredJWT(claims).encode();

const workTenant = "00000000-0000-4000-8000-000000000123";

const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";

describe("Company email domain proof from saved provider ID tokens", () => {
  it.each([
    {
      label: "Google Workspace address on its hosted domain",
      claims: {
        email: "person@company.example.test",
        email_verified: true,
        hd: "company.example.test",
      },
      domain: "company.example.test",
    },
    {
      label: "Google hosted domain in another case",
      claims: {
        email: "person@company.example.test",
        email_verified: true,
        hd: "Company.Example.Test",
      },
      domain: "company.example.test",
    },
    {
      label: "Google address on a secondary domain",
      claims: {
        email: "person@alias.example.test",
        email_verified: true,
        hd: "company.example.test",
      },
      domain: null,
    },
    {
      label: "Google account without a hosted domain",
      claims: { email: "person@gmail.com", email_verified: true },
      domain: null,
    },
    {
      label: "Google address without email verification",
      claims: {
        email: "person@company.example.test",
        email_verified: false,
        hd: "company.example.test",
      },
      domain: null,
    },
  ])("Google: $label", ({ claims, domain }) => {
    expect(providerEmailDomain("widefleet-google", token(claims))).toBe(domain);
  });

  it.each([
    {
      label: "work tenant with boolean proof",
      claims: { email: "person@company.example.test", tid: workTenant, xms_edov: true },
      domain: "company.example.test",
    },
    {
      label: "work tenant with string proof",
      claims: { email: "Person@Company.Example.Test", tid: workTenant, xms_edov: "1" },
      domain: "company.example.test",
    },
    {
      label: "personal account in the consumer tenant",
      claims: { email: "person@outlook.example.test", tid: consumerTenant, xms_edov: "1" },
      domain: null,
    },
    {
      label: "unverified domain owner",
      claims: { email: "person@company.example.test", tid: workTenant, xms_edov: false },
      domain: null,
    },
    {
      label: "missing proof",
      claims: { email: "person@company.example.test", tid: workTenant },
      domain: null,
    },
    {
      label: "other proof value",
      claims: { email: "person@company.example.test", tid: workTenant, xms_edov: "true" },
      domain: null,
    },
    {
      label: "missing tenant",
      claims: { email: "person@company.example.test", xms_edov: true },
      domain: null,
    },
  ])("Microsoft: $label", ({ claims, domain }) => {
    expect(providerEmailDomain("widefleet-microsoft", token(claims))).toBe(domain);
  });

  it("ignores missing or malformed tokens and other providers", () => {
    const google = token({
      email: "person@company.example.test",
      email_verified: true,
      hd: "company.example.test",
    });

    expect(providerEmailDomain("widefleet-google", null)).toBeNull();
    expect(providerEmailDomain("widefleet-google", "not-a-token")).toBeNull();
    expect(providerEmailDomain("microsoft", google)).toBeNull();
    expect(providerEmailDomain("credential", google)).toBeNull();
  });
});
