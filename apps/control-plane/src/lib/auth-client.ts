import { oauthDeviceAuthorizationClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/svelte";
import { emailOTPClient, organizationClient, oneTimeTokenClient } from "better-auth/client/plugins";
import { organizationAccess, organizationRoles } from "./organization.ts";

export const authClient = createAuthClient({
  plugins: [
    emailOTPClient(),
    oauthDeviceAuthorizationClient(),
    oneTimeTokenClient(),
    organizationClient({ ac: organizationAccess, roles: organizationRoles }),
  ],
});
