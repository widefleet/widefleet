import { authClientExtension } from "#auth-client-extension";
import {
  oauthDeviceAuthorizationClient,
  oauthProviderClient,
} from "@better-auth/oauth-provider/client";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/svelte";
import {
  organizationClient,
  oneTimeTokenClient,
  emailOTPClient,
  lastLoginMethodClient,
} from "better-auth/client/plugins";
import { organizationAccess, organizationRoles } from "./organization.ts";

export const authClient = createAuthClient({
  plugins: [
    ...(authClientExtension.plugins ?? []),
    ssoClient({ domainVerification: { enabled: true } }),
    emailOTPClient(),
    lastLoginMethodClient({ cookieName: "platform.last_used_login_method" }),
    oauthProviderClient(),
    oauthDeviceAuthorizationClient(),
    oneTimeTokenClient(),
    organizationClient({ ac: organizationAccess, roles: organizationRoles }),
  ],
});
