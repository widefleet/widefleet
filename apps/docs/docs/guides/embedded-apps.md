---
title: Show apps in Microsoft Teams
description: Embed published apps in a Teams tab or your own portal so colleagues use them without signing in again.
lastModified: 2026-11-19
---

Show your published apps inside a Microsoft Teams tab or another page your
colleagues already use. Widefleet signs them in with the Microsoft account they
use on that page and applies the same app access rules as everywhere else.

You need an Owner or Admin account in Widefleet and active
[company sign-in with Microsoft Entra](/guides/company-sign-in#microsoft-entra).
The page that shows your apps must get its Microsoft sign-in token from the same
Entra app registration that Widefleet uses for company sign-in. For a Teams
tab, this is the registration named in the Teams app's single sign-on settings.

## Prepare the app registration

Teams requests the token for an API exposed by the registration.

1. In the Microsoft Entra admin center, open the Widefleet registration under
   **App registrations → Expose an API**.
2. Set the **Application ID URI** and add the delegated scope `access_as_user`.
3. Add the Teams clients as authorized client applications, as described in
   Microsoft's [tab single sign-on guide](https://learn.microsoft.com/en-us/microsoftteams/platform/tabs/how-to/authentication/tab-sso-register-aad).
4. Under **Manifest**, set `requestedAccessTokenVersion` to `2`.
5. In the Teams app manifest, set `webApplicationInfo.id` to the registration's
   Application (client) ID and `webApplicationInfo.resource` to its
   Application ID URI.

## Allow the embedding pages

1. In Widefleet, open **Settings → Company sign-in**.
2. Under **Embedded apps**, choose **Add host** for each page that contains the
   app frame, directly or through another frame. For Teams, add:
   - `https://teams.microsoft.com`
   - `https://*.teams.microsoft.com`
   - `https://*.cloud.microsoft`
3. If your Teams tab shows your own page, which in turn shows the app, also add
   that page's origin, such as `https://portal.example.com`.

Administrators using the CLI or API set the same list as
[`embeddingOrigins`](/reference/company-sign-in#embedding-hosts).

## Answer sign-in requests

Show the app's launch URL in a frame, such as
`<iframe src="https://ledger.apps.example.com/">`. When a colleague needs to
sign in, Widefleet's sign-in page in that frame asks your page for a token.
Answer with a token from Teams:

```js
import { app, authentication } from "@microsoft/teams-js";

// The sign-in host of your apps: auth. followed by your app domain.
const widefleetSignIn = "https://auth.apps.example.com";

await app.initialize();

addEventListener("message", async (event) => {
  if (event.origin !== widefleetSignIn) return;
  if (event.data?.type !== "widefleet:host-token-request") return;

  try {
    const token = await authentication.getAuthToken();
    event.source.postMessage({ type: "widefleet:host-token", version: 1, token }, widefleetSignIn);
  } catch {
    event.source.postMessage(
      { type: "widefleet:host-token", version: 1, error: "unavailable" },
      widefleetSignIn,
    );
  }
});
```

Keep the listener active while the frame is shown. Widefleet asks again when
the colleague's Teams sign-in is renewed.

## Check the result

1. Open the Teams tab with an account that may open the app. The app appears in
   the tab without another sign-in.
2. Open it with an account outside the app's allowed groups. Widefleet shows
   that the account has no access to the app.

Next, [choose who may open each app](/guides/company-sign-in#check-app-access).

## If the app does not appear

| What you see                                                      | What to do                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The frame stays empty or reports that the page refused to connect | Add every page that contains the frame under **Embedded apps**, including the Teams hosts.                                              |
| An administrator must approve this app for your organization      | Grant administrator consent for the Widefleet registration in Entra, including Microsoft Graph's **User.Read** permission.              |
| Sign-in failed                                                    | Check that the token comes from the Widefleet registration in your organization's tenant and that `requestedAccessTokenVersion` is `2`. |
| The browser blocks sign-in inside embedded pages                  | Choose **Open the app in a new tab** to continue with company sign-in, or update the browser to a current version.                      |
