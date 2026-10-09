## Philosophy

This codebase will outlive you. Every shortcut becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down.
You are not just writing code. You are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.
Fight entropy. Leave the codebase better than you found it.
Prefer correctness and predictable behavior over short-term convenience.
Every platform capability must be available through the CLI, API, and UI, with consistent behavior and authorization.
Preserve runtime behavior during lint, typing, and test-structure changes.
Use public package exports; never cross package boundaries with relative imports.
Extract shared logic only for genuinely shared behavior. Avoid generic abstractions for one-off duplication.
Public PRs, commits, generated files, and documentation contain no private names, internal context, customer-derived data, or AI attribution.
Keep public setup instructions self-contained. Do not reference private repositories or their source files, or require access to them.
Inferred types over annotations. any is the enemy.

## Documentation scope

- `README.md` is the concise product entry point: purpose, product visual, core capabilities, minimal runnable quickstart, app workflow, architecture summary, current support and links to docs, support and licensing. Keep detailed instructions and reference material out.
- `apps/docs/docs/` is the canonical home for app creators and installation operators: tutorials, app/API references, self-hosting, configuration, upgrades, backups and troubleshooting. Keep these guides usable without repository-only documentation.
- `docs/` is for contributors changing Widefleet itself: development, tests, internal architecture, release publishing and documentation-site maintenance. Split mixed pages by audience. Retain link-only compatibility pointers when released clients require an old path.
- `AGENTS.md` holds concise contributor rules and content boundaries, not product documentation, tutorials or work logs.
- Document implemented behavior and required versions; distinguish unreleased features and known limits. Keep roadmaps, session notes, speculative claims, customer data and secrets out of README and public docs.
- Each topic has one canonical home; use short introductions and links elsewhere. When moving content, preserve useful details and update navigation, links and code that reads the files. README and repository guides link to public docs URLs for user topics; website pages use site routes. There is no automatic sync between the two folders.

## Documentation quality

- Separate tutorials, task guides, explanations and reference; link related pages.
- Start with the goal and prerequisites; end with an observable result and a clear next step.
- Use plain language and small, complete, runnable examples. Verify examples against the documented version.
- Cover common failures and recovery. Keep navigation predictable and advanced details easy to find.

## Control-plane UI

Design around the user's context, current task, and next step. Prefer focused flows over crowded pages; reveal secondary controls when needed.
Use the installed shadcn-svelte components and Tailwind tokens.
Use Linear as the visual reference: calm layouts, clear hierarchy, and precise interactions. When unsure about design details, look to Emil Kowalski's work for guidance.
Prefer SvelteKit remote functions for control-plane UI data access and mutations.
Keep remote functions and HTTP API handlers thin; put business logic and resource authorization in shared server modules called directly by both.
Reuse input schemas where the contracts match.
Use optimistic updates when they improve UX, with error recovery and reconciliation with server state.
Distinguish pending operations from confirmed outcomes.

## Working agreements

Discuss new dependencies and architectural decisions with lasting consequences with the maintainer before implementing them.
Ask for explicit approval before any command that can modify production systems or production data.
Never send email or chat messages.
Keep deployment changes in versioned configuration and follow the intended deployment process.

## Checks

TypeScript extends `@tsconfig/strictest` and uses the vendored anti-slop rules, type-aware Oxlint, and Oxfmt.
Do not weaken checks or suppress diagnostics to make a change pass.
Keep `oxlint` and `@oxlint/plugins` pinned to the same version.
Use local services and synthetic fixtures for verification.
