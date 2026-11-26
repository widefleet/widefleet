import { isHttpError } from "@sveltejs/kit";
import { oidcProviderInput, settingsInput, type settingsOverview } from "@platform/contracts";
import { z } from "zod";
import { authClient } from "#lib/auth-client";
import { planSettings, updateSettings } from "#lib/settings.remote";

type View = z.infer<typeof settingsOverview>;

type Provider = z.infer<typeof oidcProviderInput>["appIdentityType"];

export const ssoProviders = {
  entra: {
    label: "Microsoft Entra",
    description: "Sign in with Microsoft 365 accounts and grant app access by Entra group.",
    guide: "https://widefleet.com/docs/guides/company-sign-in#microsoft-entra",
  },
  google: {
    label: "Google Workspace",
    description: "Sign in with Google Workspace accounts and grant app access by Google group.",
    guide: "https://widefleet.com/docs/guides/company-sign-in#google-workspace",
  },
  oidc: {
    label: "OpenID Connect",
    description: "Connect Okta, Keycloak or another provider that supports OpenID Connect.",
    guide: "https://widefleet.com/docs/guides/company-sign-in#another-openid-connect-provider",
  },
} satisfies Record<Provider, { label: string; description: string; guide: string }>;

// Console pages where administrators register Widefleet. Google links follow its own
// help articles; Entra documents only the menu path, which the instructions also name.
export const providerConsoles = {
  entraAppRegistrations:
    "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  googleAuthPlatform: "https://console.developers.google.com/auth/overview",
  googleClients: "https://console.developers.google.com/auth/clients",
  googleCloudIdentityApi:
    "https://console.cloud.google.com/apis/enableflow;apiid=cloudidentity.googleapis.com",
};

export const setupStep = z.enum([
  "provider",
  "register",
  "credentials",
  "domain",
  "test",
  "activate",
]);

export const setupSteps = [
  { id: "provider", label: "Choose provider" },
  { id: "register", label: "Register Widefleet" },
  { id: "credentials", label: "Enter credentials" },
  { id: "domain", label: "Verify email domain" },
  { id: "test", label: "Test sign-in" },
  { id: "activate", label: "Activate" },
] satisfies { id: z.infer<typeof setupStep>; label: string }[];

// Company sign-in works once a domain is verified, or right away when the installation
// operator trusts the provider.
export const ssoReady = (view: View) =>
  Boolean(view.sso && (view.sso.domainVerified || !view.ssoPolicy.domainVerificationRequired));

export const domainRequired = (view: View, provider: Provider) =>
  view.ssoPolicy.domainVerificationRequired || provider === "google";

// A saved connection continues setup where it still needs work. Activation needs the
// administrator's account linked to the provider, or they could not sign in afterwards.
export const nextSetupStep = (view: View, linked: boolean): z.infer<typeof setupStep> =>
  !view.sso ? "provider" : !ssoReady(view) ? "domain" : linked ? "activate" : "test";

export type SsoDraft = Omit<z.infer<typeof settingsInput>, "sso"> & {
  sso: z.infer<typeof oidcProviderInput>;
};

export const ssoDraft = (view: View, organizationId: string): SsoDraft => ({
  ...structuredClone(view.settings),
  // Embedding hosts change in their own section. Leaving them out of the
  // connection draft keeps a connection save from restoring an older list.
  embeddingOrigins: undefined,
  allowBrowserWorkers: undefined,
  directory: view.settings.directory ? { ...view.settings.directory, clientSecret: "" } : null,
  sso: view.sso
    ? {
        providerId: view.sso.providerId,
        appIdentityType: view.sso.appIdentityType,
        issuer: view.sso.issuer,
        // Saved connections manage their email domains in a separate list.
        domain: undefined,
        oidcConfig: { ...structuredClone(view.sso.oidcConfig), clientSecret: "" },
      }
    : {
        providerId: `company-${organizationId}`,
        appIdentityType: "oidc",
        issuer: "",
        domain: "",
        oidcConfig: {
          clientId: "",
          clientSecret: "",
          pkce: true,
          scopes: ["openid", "profile", "email"],
          mapping: { name: "name", email: "email", extraFields: { groups: "groups" } },
        },
      },
});

export const ssoInput = (draft: SsoDraft, view: View) =>
  settingsInput.parse({
    ...draft,
    externallyManaged: view.settings.externallyManaged,
    directory: draft.directory
      ? { ...draft.directory, clientSecret: draft.directory.clientSecret || undefined }
      : null,
    sso: {
      ...draft.sso,
      oidcConfig: {
        ...draft.sso.oidcConfig,
        scopes: draft.sso.oidcConfig.scopes.filter(Boolean),
        clientSecret: draft.sso.oidcConfig.clientSecret || undefined,
      },
    },
  });

export const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof z.ZodError
    ? "Check your provider details and credentials."
    : isHttpError(cause)
      ? cause.body.message
      : cause instanceof Error
        ? cause.message
        : fallback;

// Saves settings through the plan, asking first when the sign-in service must restart.
export class SettingsWriter {
  busy = $state(false);

  error = $state("");

  pending = $state<z.infer<typeof settingsInput> | null>(null);

  restartOpen = $state(false);

  #saved: () => void | Promise<void>;

  #organizationId: () => string;

  constructor(organizationId: () => string, saved: () => void | Promise<void>) {
    this.#organizationId = organizationId;
    this.#saved = saved;
  }

  #apply = async (input: z.infer<typeof settingsInput>, acknowledgeRestart: boolean) => {
    const result = await updateSettings({
      ...input,
      acknowledgeRestart,
      organizationId: this.#organizationId(),
    });

    if (result.signedOut) {
      window.location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`);

      return;
    }

    // The update command refreshes the settings query before it returns.
    this.pending = null;
    this.restartOpen = false;
    await this.#saved();
  };

  save = async (input: () => z.infer<typeof settingsInput>) => {
    this.busy = true;
    this.error = "";

    try {
      const next = input();
      const plan = await planSettings({ ...next, organizationId: this.#organizationId() });

      if (plan.restartRequired) {
        this.pending = structuredClone(next);
        this.restartOpen = true;
      } else await this.#apply(next, false);
    } catch (cause) {
      this.error = failureMessage(cause, "Could not save changes.");
    } finally {
      this.busy = false;
    }
  };

  confirm = async () => {
    if (!this.pending) return;
    this.busy = true;
    this.error = "";

    try {
      await this.#apply($state.snapshot(this.pending), true);
    } catch (cause) {
      this.error = failureMessage(cause, "Could not save changes.");
      this.restartOpen = false;
    } finally {
      this.busy = false;
    }
  };

  cancel = () => {
    this.pending = null;
    this.restartOpen = false;
  };
}

// Redirects to the company provider; resolves with an error message if it cannot start.
export const startCompanySignIn = async (providerId: string, returnTo: string) => {
  const separator = returnTo.includes("?") ? "&" : "?";

  try {
    const result = await authClient.signIn.sso({
      providerId,
      callbackURL: returnTo,
      errorCallbackURL: `${returnTo}${separator}error=sso`,
    });

    return result.error ? "Could not start company sign-in." : null;
  } catch {
    return "Could not start company sign-in. Check your connection.";
  }
};
