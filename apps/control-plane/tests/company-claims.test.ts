import { describe, expect, it, vi } from "vitest";
import { companyProvider } from "@platform/contracts";
import { readCompanyClaims } from "../src/lib/server/company-claims.ts";
import { readCompanyGroups } from "../src/lib/server/company-groups.ts";

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
  it("reads all transitive membership pages and accepts only groups", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    let calls = 0;

    const groups = await readCompanyGroups("fixture-token", subject, async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toContain("https://graph.microsoft.com/v1.0/");
      expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
      expect(request.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      signals.push(init?.signal);
      calls += 1;

      const body = {
        value: [
          { id: group, "@odata.type": "#microsoft.graph.group" },
          { id: subject, "@odata.type": "#microsoft.graph.directoryRole" },
        ],
      };

      return Response.json(
        calls === 1
          ? {
              ...body,
              "@odata.nextLink": `https://graph.microsoft.com/v1.0/users/${subject}/transitiveMemberOf?$skiptoken=next`,
            }
          : body,
      );
    });

    expect(groups).toEqual([group]);
    expect(calls).toBe(2);
    expect(signals[0]).toBe(signals[1]);
  });

  it("rejects unsafe pagination, incomplete results and excessive lookup work", async () => {
    const request = vi.fn(async () =>
      Response.json({
        value: [{ id: group, "@odata.type": "#microsoft.graph.group" }],
        "@odata.nextLink": "https://untrusted.example.test/next",
      }),
    );

    await expect(readCompanyGroups("fixture-token", subject, request)).rejects.toThrow(
      "Unexpected company membership page",
    );
    expect(request).toHaveBeenCalledTimes(1);

    const endless = vi.fn(async () =>
      Response.json({
        value: [{ id: group, "@odata.type": "#microsoft.graph.group" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$skiptoken=next",
      }),
    );

    await expect(readCompanyGroups("fixture-token", subject, endless)).rejects.toThrow(
      "exceed the lookup limit",
    );
    expect(endless).toHaveBeenCalledTimes(20);
    await expect(
      readCompanyGroups("fixture-token", subject, async () => new Response(null, { status: 403 })),
    ).rejects.toThrow("could not be verified");
  });

  it("uses one deadline for the whole lookup", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);

    const request = vi.fn(async () => {
      controller.abort(new Error("Lookup deadline"));

      return Response.json({ value: [] });
    });

    try {
      await expect(readCompanyGroups("fixture-token", subject, request)).rejects.toThrow(
        "Lookup deadline",
      );
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
});
