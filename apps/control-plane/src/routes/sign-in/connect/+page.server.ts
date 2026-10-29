import { error } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { availableSocialProviders } from "#server/social-sign-in";
import { localDestination } from "#server/navigation";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ request, url, setHeaders }) => {
  setHeaders({ "cache-control": "private, no-store" });
  const runtime = await getRuntime();

  const provider = availableSocialProviders(runtime.configuration).find(
    (value) => value === url.searchParams.get("provider"),
  );

  if (!provider) error(404, "Sign-in provider is unavailable");
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  const next = localDestination(url.searchParams.get("next"));

  const fresh =
    session?.user.emailVerified &&
    !session.session.identityOrganizationId &&
    !session.session.recovery &&
    Date.now() - session.session.createdAt.getTime() < 10 * 60 * 1000;

  return {
    provider,
    next,
    returnTo: `/sign-in/connect?${new URLSearchParams({ provider, next })}`,
    email: session?.user.email ?? "",
    canLink: Boolean(fresh) && url.searchParams.get("verify") !== "email",
    emailSignIn: runtime.emailSignIn,
    publicSignup: runtime.publicSignup,
    codeDelivery: runtime.configuration.LOGIN_CODE_DELIVERY,
    failure: url.searchParams.get("error"),
  };
};
