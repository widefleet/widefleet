import { oidcProviderInput, settingsInput, settingsView } from "@platform/contracts";
import type { z } from "zod";

// The export document contains the native provider's editable fields, without
// its verification status or secret. An omitted secret is preserved by SSO.
export const editableSettings = (view: z.infer<typeof settingsView>) =>
  settingsInput.parse({
    ...view.settings,
    sso: view.sso ? oidcProviderInput.strip().parse(view.sso) : null,
  });
