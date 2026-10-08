import { z } from "zod";
import { describe, expect, it } from "vitest";
import { companyProvider } from "@platform/contracts";
import { readCompanyClaims } from "../src/lib/server/company-claims.ts";
import { checkCompanyGroups } from "../src/lib/server/company-groups.ts";

const provider = companyProvider.parse({
  type: "entra",
  tenantId: "00000000-0000-4000-8000-000000000001",
});

const issuer = "https://login.microsoftonline.com/00000000-0000-4000-8000-000000000001/v2.0";

const subject = "00000000-0000-4000-8000-000000000002";

const group = "00000000-0000-4000-8000-000000000003";

// This parser receives tokens already persisted by Better Auth after verification.
const token = (claims = {}) =>
  `${Buffer.from('{"alg":"fixture"}').toString("base64url")}.${Buffer.from(JSON.stringify({ iss: issuer, tid: "00000000-0000-4000-8000-000000000001", sub: "client-specific", oid: subject, exp: Math.floor(Date.now() / 1000) + 600, groups: [group], ...claims })).toString("base64url")}.fixture`;

describe("Company authorization claims", () => {
  it("uses issuer-scoped object IDs and bounds groups by the issuer token expiry", () => {
    expect(readCompanyClaims(provider, { accountId: subject, idToken: token() })).toMatchObject({
      provider: issuer,
      subject,
      groups: [group],
      groupsExpired: false,
    });
    expect(
      readCompanyClaims(provider, { accountId: subject, idToken: token({ exp: 1 }) }),
    ).toMatchObject({ subject, groups: [], groupsExpired: true });

    for (const claims of [
      { iss: "https://other.example.test" },
      { tid: "00000000-0000-4000-8000-000000000004" },
      { oid: "another-person" },
    ])
      expect(
        readCompanyClaims(provider, { accountId: subject, idToken: token(claims) }),
      ).toBeUndefined();
  });
  it("recognizes overage without following token-supplied URLs", () => {
    expect(
      readCompanyClaims(provider, {
        accountId: subject,
        idToken: token({
          groups: undefined,
          _claim_names: { groups: "source" },
          _claim_sources: { source: { endpoint: "https://untrusted.example.test" } },
        }),
      }),
    ).toMatchObject({ groups: [], overage: true });
  });
  it("supports a shared OIDC subject claim while rejecting mismatched accounts", () => {
    const oidc = companyProvider.parse({
      type: "oidc",
      issuer,
      label: "Company",
      subjectClaim: "employee_id",
      groupsClaim: "roles",
    });

    expect(
      readCompanyClaims(oidc, {
        accountId: subject,
        idToken: token({ employee_id: subject, roles: ["engineering"] }),
      }),
    ).toMatchObject({ subject, groups: ["engineering"] });
    expect(
      readCompanyClaims(oidc, {
        accountId: "client-specific",
        idToken: token({ employee_id: subject }),
      }),
    ).toBeUndefined();
  });
  it("checks overage memberships in bounded delegated Graph requests", async () => {
    const candidates = Array.from({ length: 25 }, () => crypto.randomUUID());
    const batches: string[][] = [];

    const groups = await checkCompanyGroups("fixture-token", candidates, async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://graph.microsoft.com/v1.0/me/checkMemberGroups");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      const parsed = z.object({ groupIds: z.array(z.uuid()) }).parse(await request.json());
      batches.push(parsed.groupIds);

      return Response.json({ value: parsed.groupIds.slice(0, 1) });
    });

    expect(batches.map((batch) => batch.length)).toEqual([20, 5]);
    expect(groups).toEqual([candidates[0], candidates[20]]);
    await expect(
      checkCompanyGroups("fixture-token", [group], async () => Response.json({ value: [subject] })),
    ).rejects.toThrow("Unexpected company group membership");
    await expect(
      checkCompanyGroups("fixture-token", [group], async () => new Response(null, { status: 403 })),
    ).rejects.toThrow("could not be verified");
  });
});
