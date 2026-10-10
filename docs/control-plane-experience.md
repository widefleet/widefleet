# Control-plane interaction constraints

Use these constraints when changing flows that cross authentication, permissions or background operations. The [contributor UI rules](../AGENTS.md#control-plane-ui) own the visual and component guidance; [local verification](development.md#local-verification) explains how to exercise changes.

## Keep app usage separate from management

The app catalog helps people find and open apps. Listing an app does not grant management access or bypass its app access rules. Keep app usage and management grants distinct in navigation, labels and feedback so users do not mistake one permission for the other.

App usage rules are inherited by previews. An editor must show that ownership and retain a user's draft when the server reports a revision conflict, allowing an explicit reload or retry instead of silently overwriting either version.

## Show what has actually completed

Saving desired configuration or receiving a job ID does not mean the runtime or proxy has applied it. Show submission, pending execution and confirmed outcomes separately. Keep the last known result when a refresh fails, and preserve operation feedback across app-tab navigation.

One-time credentials need special handling: a successful registration followed by a failed list refresh must not hide the only copy of the credential or encourage duplicate registration. Refreshing surrounding data must not discard a successful mutation's result.

The [app-management browser tests](../apps/control-plane/tests/e2e/auth.spec.ts) cover these interactions against server state, including permission changes while a page is open.

## Preserve progress across authentication

Initial setup crosses local-owner creation, identity configuration, company sign-in and account verification. Preserve progress through redirects and keep temporary password access until the owner has linked and verified a company account. A successful provider configuration save alone is not evidence that the owner can sign in.

CLI authorization must let the user compare the device code and understand whether approval or rejection succeeded before returning to the terminal. Keep this flow focused on the request they arrived to verify.

See the [setup tests](../apps/control-plane/tests/e2e/setup.spec.ts) and [authentication tests](../apps/control-plane/tests/e2e/auth.spec.ts) when changing these boundaries.

## Preserve native navigation and forms

Addressable app tabs and native form submissions must continue working without JavaScript. Enhancement may improve feedback, but authorization, validation and recovery cannot depend on client state. Authentication redirects and HTTP errors need to work on the initial page request as well as subsequent remote calls.

Verify changed journeys with and without JavaScript, including keyboard use, narrow layouts and recoverable failures. Use local services and synthetic identities; the browser tests are the maintained record of supported cases.
