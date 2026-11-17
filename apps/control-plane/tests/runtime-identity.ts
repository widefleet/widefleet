import { authConfiguration, createAuthProxy } from "@platform/auth-proxy";
import { z } from "zod";
import { createIdentityProvider } from "./edge/auth-proxy-idp.ts";

const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .flatMap((value) => (value.includes("Max-Age=0") ? [] : [value.split(";")[0]]))
    .join("; ");

// Deployment tests use a real login cookie; they never bypass the runtime's
// authentication. The disposable provider is not needed for later app calls.
export const runtimeIdentity = async (
  domain = "apps.example.test",
  groups: string[] = [],
  otherGroups?: string[],
  otherSubject?: string,
) => {
  const redirectUrl = `https://auth.${domain}/oauth2/widefleet/callback`;
  const provider = await createIdentityProvider(redirectUrl);
  provider.settings.groups = groups;

  try {
    const configuration = authConfiguration.parse({
      organizationId: "widefleet",
      provider: {
        type: "oidc",
        issuer: provider.origin,
        label: "Fixture",
        nameClaim: "display_name",
        emailClaim: "mail",
        groupsClaim: "roles",
      },
      clientId: "app-login",
      clientSecret: "synthetic-client-secret",
      cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
      domain,
      redirectUrl,
    });

    const app = `https://fixture.${domain}/`;

    const proxy = createAuthProxy(configuration, {
      resolve: async () => ({ revision: 1, groups: [] }),
      fetch: async () => new Response("Fixture"),
    });

    const login = async () => {
      const started = await proxy.fetch(
        new Request(`https://auth.${domain}/oauth2/widefleet/start?rd=${encodeURIComponent(app)}`),
      );

      const authorized = await fetch(z.url().parse(started.headers.get("location")), {
        redirect: "manual",
      });

      const completed = await proxy.fetch(
        new Request(z.url().parse(authorized.headers.get("location")), {
          headers: { cookie: cookies(started) },
        }),
      );

      if (completed.headers.get("location") !== app) throw new Error("Fixture sign-in failed");

      return cookies(completed);
    };

    const cookie = await login();
    provider.settings.groups = otherGroups ?? [];
    provider.settings.subject = otherSubject ?? provider.settings.subject;
    const otherCookie = otherGroups ? await login() : undefined;

    return { configuration, cookie, otherCookie };
  } finally {
    await provider.stop();
  }
};
