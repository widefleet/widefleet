# Control-plane interaction constraints

Use these constraints when changing flows that cross authentication, permissions or background operations. The [design guidelines](design.md) cover visual decisions and review; [local verification](development.md#local-verification) explains how to exercise changes.

## Keep app usage separate from management

The app catalog helps people find and open apps. Listing an app does not grant management access or bypass its app access rules. Keep app usage and management grants distinct in navigation, labels and feedback so users do not mistake one permission for the other.

App usage rules are inherited by previews. An editor must show that ownership and retain a user's draft when the server reports a revision conflict, allowing an explicit reload or retry instead of silently overwriting either version.

## Show what has actually completed

Show submission, pending execution and confirmed outcomes separately. Saving desired configuration or receiving a job ID confirms submission; the runtime or proxy confirms application. Keep the last known result when a refresh fails, and preserve operation feedback across app-tab navigation.

Keep newly issued one-time credentials visible even if refreshing the surrounding list fails. Preserve the successful registration result so users can copy the credential without registering again.

The [app-management browser tests](../apps/control-plane/tests/e2e/auth.spec.ts) cover these interactions against server state, including permission changes while a page is open.

## Preserve progress across authentication

Initial setup crosses local-owner creation, identity configuration, company sign-in and account verification. Preserve progress through redirects and keep temporary password access until the owner has linked and verified a company account using the saved provider configuration.

CLI authorization must let the user compare the device code and understand whether approval or rejection succeeded before returning to the terminal. Keep this flow focused on the request they arrived to verify.

See the [setup tests](../apps/control-plane/tests/e2e/setup.spec.ts) and [authentication tests](../apps/control-plane/tests/e2e/auth.spec.ts) when changing these boundaries.

## Preserve native navigation and forms

Addressable app tabs and native form submissions must continue working without JavaScript. Enhancement may improve feedback, but authorization, validation and recovery cannot depend on client state. Authentication redirects and HTTP errors need to work on the initial page request as well as subsequent remote calls.

Verify changed journeys with and without JavaScript, including keyboard use, narrow layouts and recoverable failures. Use local services and synthetic identities; the browser tests are the maintained record of supported cases.
