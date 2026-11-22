import { error } from "@sveltejs/kit";
import { getRuntime } from "#server/runtime";
import { availableSocialProviders, readCompanySsoHint } from "#server/social-sign-in";
import { localDestination } from "#server/navigation";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, url }) => {
  const runtime = await getRuntime();

  const provider = availableSocialProviders(runtime.configuration).find(
    (value) => value === url.searchParams.get("provider"),
  );

  if (!provider) error(404, "Sign-in provider is unavailable");
  const { session, user } = locals;
  const next = localDestination(url.searchParams.get("next"));

  const fresh =
    user?.emailVerified &&
    session &&
    !session.identityOrganizationId &&
    !session.recovery &&
    Date.now() - session.createdAt.getTime() < 10 * 60 * 1000;

  const failure = url.searchParams.get("error");
  const hint = url.searchParams.get("error_description");

  const companySso =
    failure === "company_sso_required" && hint
      ? await readCompanySsoHint((await runtime.auth.$context).secretConfig, hint)
      : null;

  return {
    provider,
    next,
    returnTo: `/sign-in/connect?${new URLSearchParams({ provider, next })}`,
    email: user?.email ?? "",
    canLink: Boolean(fresh) && url.searchParams.get("verify") !== "email",
    emailSignIn: runtime.emailSignIn,
    publicSignup: runtime.publicSignup,
    codeDelivery: runtime.configuration.LOGIN_CODE_DELIVERY,
    failure,
    companySso,
  };
};
