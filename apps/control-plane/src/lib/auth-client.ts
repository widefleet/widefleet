import {
  oauthDeviceAuthorizationClient,
  oauthProviderClient,
} from "@better-auth/oauth-provider/client";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/svelte";
import { organizationClient, oneTimeTokenClient, emailOTPClient } from "better-auth/client/plugins";
import { organizationAccess, organizationRoles } from "./organization.ts";

export const authClient = createAuthClient({
  plugins: [
    ssoClient({ domainVerification: { enabled: true } }),
    emailOTPClient(),
    oauthProviderClient(),
    oauthDeviceAuthorizationClient(),
    oneTimeTokenClient(),
    organizationClient({ ac: organizationAccess, roles: organizationRoles }),
  ],
});
