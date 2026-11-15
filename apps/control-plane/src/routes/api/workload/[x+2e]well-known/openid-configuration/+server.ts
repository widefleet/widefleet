import type { RequestHandler } from "./$types";
import { workloadIssuer } from "#server/workload-identity";

export const GET: RequestHandler = async ({ locals }) => {
  const { configuration } = await locals.runtime();

  return Response.json({
    issuer: workloadIssuer(configuration.PLATFORM_URL),
    jwks_uri: `${configuration.PLATFORM_URL}/api/auth/jwks`,
    id_token_signing_alg_values_supported: ["EdDSA"],
    subject_types_supported: ["public"],
    response_types_supported: [],
    claims_supported: [
      "iss",
      "sub",
      "aud",
      "iat",
      "exp",
      "jti",
      "workload_type",
      "organization_id",
      "app_id",
    ],
  });
};
