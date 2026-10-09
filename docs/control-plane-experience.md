# Control plane experience

The control plane should help people understand where they are, what is happening, and what they can do next. This redesign uses the existing shadcn-svelte components and Tailwind foundation to give everyday app management and first-time setup clear, consistent paths.

## Goals

- Use English throughout the interface, including validation, accessibility labels, status messages, and date formatting.
- Organize screens around user tasks and the information needed for the current decision.
- Give platform administration, individual apps, and account actions distinct places.
- Guide first-time setup through prerequisites, configuration, activation, account verification, and completion. Preserve progress across authentication redirects.
- Make finding an app, creating an app, publishing its first version, inspecting deployments, and managing access understandable without knowing the implementation.
- Distinguish a submitted request from a running operation and a confirmed outcome. Keep errors actionable and preserve entered data.
- Use a quiet visual hierarchy: persistent navigation, compact lists, restrained color, consistent spacing, readable typography, and contextual actions.
- Preserve the official black logo and lowercase wordmark, including their proportions. Give them a light background in dark layouts; transparent favicons follow the browser's color scheme.
- Preserve authorization, API and CLI contracts, native remote-form submissions, and existing security protections.
- Support keyboard navigation, narrow screens, reduced motion, loading, empty, error, and permission states.

## 1. User situations

| Situation                                | User need                                                       | Useful next step                                                             |
| ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Administrator opening a new installation | Understand prerequisites and establish company sign-in safely   | Configure identity, verify the account, then close temporary password access |
| Member opening an empty workspace        | Understand what the platform does and how to start              | Create an app and see instructions for publishing its first version          |
| Returning member                         | Find the relevant app and understand its current state          | Search apps and open their overview                                          |
| App maintainer after publishing          | Know which version is active and whether work is still pending  | Inspect deployments and refresh operation state                              |
| App maintainer after a failed deployment | Understand the failure and recovery options                     | Inspect the recorded message or request restoration of a successful version  |
| App owner sharing management             | Understand who can administer the app and what permission means | Search members and grant or revoke management access                         |
| Platform administrator                   | Manage members, deployment agents, and platform settings        | Open the relevant administration area                                        |
| CLI user arriving from a terminal        | Verify the request and return to the terminal                   | Compare the code, approve or reject, and receive a clear outcome             |

## 2. Navigation and flows

- **Apps:** searchable overview, clear empty state, and a primary create action.
- **App catalog:** discover and open apps listed by their owners; listing never grants management access or bypasses app access rules.
- **Create app:** focused page with name, URL identifier, and optional preview relationship; successful creation leads to the app overview.
- **App:** shared identity and navigation for Overview, Deployments, Access, and Settings. Navigation is addressable and works without JavaScript.
- **Overview:** current publication state, app URL, preview relationship, and the next useful action. An unpublished app includes an explicit first-deployment path.
- **Deployments:** history, current-version marker, recorded errors, and restoration with pending/accepted feedback.
- **Access:** separate app usage from management access. Show company group rules, inheritance, activation status, and revision conflicts in the app usage section. Keep management grants and member search in their own section.
- **App settings:** technical identity, optional catalog listing, and deliberate deletion that explicitly includes all previews.
- **Members:** searchable people list with contextual role editing and pagination.
- **Deployment agents:** registration and one-time credential handoff in platform administration.
- **Settings:** separate identity configuration, account verification, reporting preferences, and configuration ownership.
- **Initial setup:** administrator account → identity provider → management sign-in → published-app sign-in → activate → verify company account → finish.
- **Account:** sign out and appearance preference in the shared frame. Authentication, recovery, and CLI authorization use focused pages.

Simple tasks stay short. Multi-step presentation is reserved for work with real dependencies. Advanced options appear in their relevant context. A user must be able to return to earlier steps without losing unsaved fields.

## 3. First complete path

Build the shared navigation and visual tokens, then complete the path from the app overview through creation, first-deployment guidance, and deployment results. Use that path to establish reusable patterns for page headings, status, form fields, empty states, and feedback.

Use the installed components directly. Keep shared components specific to genuinely repeated behavior. Remove the old global element styling so that it cannot override component variants. Keep business rules and authorization in the existing server modules and remote functions.

## 4. Complete and verify

Apply the established patterns to app access, app deletion, members, agents, settings, first-time setup, sign-in, recovery, and CLI authorization. Check the complete journeys with local services and synthetic data.

Acceptance checks:

- Source formatting, strict type checking, lint, and production build pass.
- Browser tests cover creation, previews, roles, grants, deletion, rollback pending states, setup, SSO, and CLI confirmation.
- Native form submissions still work without JavaScript.
- Navigation, search, mobile layout, focus handling, and reduced-motion behavior are exercised.
- Visually inspect desktop and narrow layouts with empty, populated, and failure states.
- Review the final diff for unrelated changes and publish a pull request through the normal review process.

Design reference: [Emil Kowalski's design engineering guidance](https://emilkowal.ski/skill), especially purposeful motion, immediate feedback, accessibility, and consistent interaction details.

## Progress

- [x] Inspect the existing interface, component foundation, server boundaries, and browser coverage.
- [x] Record user situations, navigation, flows, and acceptance criteria.
- [x] Implement the first complete app-management path.
- [x] Complete the remaining flows and interaction states.
- [x] Verify behavior and visual quality.

## Visual review

Screenshots use a disposable local installation and synthetic examples.

- [App overview, light](assets/control-plane/apps-light.png)
- [App overview, dark](assets/control-plane/apps-dark.png)
- [First deployment guidance](assets/control-plane/first-deployment.png)
- [App creation on mobile](assets/control-plane/create-mobile.png)
- [App catalog](assets/control-plane/catalog.png)

## Verification

- `pnpm check`: strict TypeScript, Svelte diagnostics, formatting, and type-aware lint pass.
- `pnpm --filter @platform/control-plane build`: production build passes.
- `pnpm --filter @platform/control-plane test:e2e`: 25 browser tests pass against the built server, including native forms, SSO, inherited app access, catalog publication, pending operations across tab navigation, retained access drafts and revision conflicts, one-time credential recovery after refresh failures, live role changes, activation failures, unavailable preview parents, and revoked access.
- Auth, organization, settings, platform, and reporting integration suites: 63 tests pass.
- English copy, document language, and date formatting verified; review screenshots refreshed.
- Desktop light/dark and mobile visual review completed. The app, catalog, creation, deployment, access, member, agent, and settings views fit a 320 px viewport without horizontal page overflow or browser errors.

The pull request is the review boundary for shipping these changes.
