# Documentation website

Build, preview and maintain the documentation site. Run commands from the repository root. For contributor setup, see [development](development.md).

## Local development

The Blume documentation website lives in `apps/docs`. Its `docs/` directory is the
canonical source for app creators and installation operators, including self-hosting,
upgrades, backups and reference material. The repository-root `docs/` contains only
contributor guidance. No content is synchronized between these directories.

Use site routes in published pages and `https://widefleet.com/docs/...` links from
repository documents. Keep navigation in each section's `meta.ts`. Validate links
and build after moving pages; `tools/package-cli.ts` also reads the public CLI
installation guide to generate the README included in CLI releases.
The public documentation URL is `https://widefleet.com/docs`. Start the docs at
`http://localhost:4321/docs`:

```sh
pnpm --filter @platform/docs run dev
```

The development server keeps pages, JavaScript, styles, fonts and hot reload
under `/docs`. A separate website dev server can proxy that prefix, including
WebSockets, to `http://127.0.0.1:4321` without rewriting paths. Start both servers
separately. The dev-only integration in `apps/docs/blume.config.ts` lets Vite
handle the prefix once and preserves the public base for component URLs;
production builds keep Blume's normal `/docs` configuration.

`DOCS_WEBSITE_URL` controls the website, logo and legal-page destinations. It
defaults to `http://localhost:5178` in development and `https://widefleet.com` in
production builds. Override it when using another local website origin. The
separate **Docs** label returns to `/docs`. The logo stays black in both themes,
with a light background in dark mode.

For a local production preview without analytics:

```sh
DOCS_POSTHOG_KEY= pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run preview --port 4321
```

The build writes `apps/docs/dist`. The preview command prepares the assets and
uses local Wrangler, matching production routing and headers without deploying.
Stop the development server before building or
starting a preview on the same port. To verify a build while the docs dev server
is running, use `pnpm --filter @platform/docs run build --isolated`; its output
goes to `.blume-verify/dist`. Generated discovery files are available in the
production preview after a build; the dev server does not emit them.

## Hosting under /docs

Blume uses `deployment.site: "https://widefleet.com"` and
`deployment.base: "/docs"`. This prefixes pages, assets, canonical URLs,
Markdown, search, the docs JSON API, sitemap and generated agent resources.
`apps/docs/wrangler.jsonc` owns the public routes for the `widefleet-docs` static
asset Worker. Cloudflare sends `/docs` and `/docs/*`, plus the five root discovery
aliases below, directly to this Worker. The website serves the remaining paths
on `widefleet.com` and links to `/docs`; no website proxy or service binding is
required for production docs traffic.

The routes use the exact `widefleet.com` hostname. Their trailing `*` also matches
query strings, including `/docs?source=website` and `/SKILL.md?version=1`.
These six prefixes are reserved for the docs: suffixes such as `/docs-missing`
also reach the docs Worker and return its 404. Unrelated `/.well-known/*` paths
remain with the website. See [Cloudflare's route matching rules](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior).

Keep the website's existing `widefleet.com` Custom Domain and proxied DNS record.
The docs routes take precedence for their paths without taking ownership of the
whole hostname. See [Cloudflare's Routes documentation](https://developers.cloudflare.com/workers/configuration/routing/routes/#background).
The separate `docs.widefleet.com` Custom Domain serves only docs Previews;
`workers.dev` URLs remain disabled.

For an explicitly approved manual deployment, authenticate Wrangler and run:

```sh
pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run deploy
```

`deploy` first runs `prepare:deploy`, which copies the existing build into
`.wrangler/docs-assets/docs` and moves Cloudflare response rules to the asset
root. This is necessary because Astro's base option changes URLs without nesting
its output directory. It also writes `_redirects` rules that serve the root
discovery aliases from their generated `/docs` resources with status 200, keeping
the requested URL. Alias response headers are copied from the generated rules.
Wrangler then deploys the prepared assets. Rebuild without local URL overrides
before deployment. There are no compatibility redirects for earlier URLs.

For a Preview, build without analytics before deploying:

```sh
DOCS_POSTHOG_KEY= pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run deploy:preview
pnpm --filter @platform/docs run deploy:preview --name review
```

`deploy:preview` prepares the existing build and runs `wrangler preview`. The
Preview name defaults to the current Git branch; `--name review` serves the docs
at `https://review.docs.widefleet.com/docs`. The `previews` block inherits the
static assets configuration. Apply the custom domain configuration through the
approved production deployment process before deploying Previews, and ensure the
certificate covers `*.docs.widefleet.com`. For public Previews without a login,
Cloudflare Access policies must also allow them; this configuration does not
change Access policies. `prepare:deploy` adds a hostname-specific `X-Robots-Tag: noindex` header
for `*.docs.widefleet.com`, including named and unique deployment URLs. Production
requests at `widefleet.com/docs` do not match this rule. See
[Cloudflare's Preview custom domain documentation](https://developers.cloudflare.com/workers/previews/custom-domains/).

For local Cloudflare testing, prepare the assets and serve the internal Worker:

```sh
pnpm --filter @platform/docs run prepare:deploy
pnpm --filter @platform/docs exec wrangler dev --port 8788
```

Open `http://localhost:8788/docs`, `/SKILL.md` or one of the discovery aliases.
The docs Worker serves these URLs on its own. A website development server can
optionally proxy these paths to this local origin.

The routing regression test uses local Workers and synthetic assets. It checks
the actual Wrangler routes against a separate website fixture, root aliases,
response headers, query strings and Preview indexing rules:

```sh
pnpm exec vitest run apps/docs/tests/routing.test.ts
```

In Cloudflare Workers Builds, keep the root directory at `/` and set:

| Setting         | Command                                           |
| --------------- | ------------------------------------------------- |
| Build command   | `pnpm --filter @platform/docs run build`          |
| Deploy command  | `pnpm --filter @platform/docs run deploy`         |
| Preview command | `pnpm --filter @platform/docs run deploy:preview` |

This builds once before the selected deployment command runs. Set
`DOCS_POSTHOG_KEY` to an empty string in the Preview build environment to disable
analytics. Deployment commands do not change analytics in already-built files.

Each docs branch Preview serves its own build, including the root discovery
aliases. The production zone routes do not target Preview deployments or website
Preview hosts. Independently hosted website Previews should link to
`https://widefleet.com/docs` or a selected docs Preview URL instead of assuming
their own `/docs` path serves documentation.

## Switching from a website proxy

Deploy this docs configuration through the approved production deployment
process first. Its routes take precedence over the website's Custom Domain, so
production docs traffic no longer enters the website Worker. Verify `/docs`,
its assets, `/SKILL.md` and the four root discovery manifests on `widefleet.com`.

Then remove the website's docs forwarding hook, root-alias rewrites and `DOCS`
service bindings, including the binding in its Preview configuration. Update
website Preview links to the production docs URL or a selected docs Preview URL.
The website keeps its `/docs` links in production, `/robots.txt`, `/llms.txt`,
sitemap index and shared consent behavior. Existing website Previews continue
using their old binding until that separate cleanup is deployed.

## Agent and search discovery

The build publishes `/docs/SKILL.md`, `/docs/llms.txt`, `/docs/llms-full.txt`,
per-page Markdown, `/docs/api/docs/*`, `/docs/openapi.json`,
`/docs/agent-readability.json` and `/docs/.well-known/*`. The OpenAPI document
describes the documentation API, not Widefleet's platform API.

The build integration in `apps/docs/blume.config.ts` renames Blume's generated
skill to `dist/SKILL.md`. The deployed filename is also `SKILL.md`; the lowercase
file is not retained. Skill content and discovery metadata remain generated by Blume.

The docs deployment also owns these origin-level aliases:

| Public URL                             | Generated resource                          |
| -------------------------------------- | ------------------------------------------- |
| `/SKILL.md`                            | `/docs/SKILL.md`                            |
| `/.well-known/agent-skills/index.json` | `/docs/.well-known/agent-skills/index.json` |
| `/.well-known/ai-catalog.json`         | `/docs/.well-known/ai-catalog.json`         |
| `/.well-known/ard.json`                | `/docs/.well-known/ard.json`                |
| `/.well-known/api-catalog`             | `/docs/.well-known/api-catalog`             |

`apps/docs/scripts/prepare-assets.ts` creates the asset rewrites and preserves
their content types and CORS headers. Generated manifests already reference the
canonical `/docs` resource URLs; no content rewriting or cross-repository file
copying is needed. When adding an alias, update both the explicit Wrangler route
and the preparation script, then extend the routing test.

The public website manages the origin's `/robots.txt`, `/llms.txt` and a sitemap
index that includes `/docs/sitemap.xml`. The docs build does not generate a second
robots policy below `/docs`.

PostHog uses the public browser project token in `apps/docs/blume.config.ts`.
Override it with `DOCS_POSTHOG_KEY` in the build environment; personal API keys
must never be used here. The ingestion host is `https://eu.i.posthog.com`.
`apps/docs/.env.example` documents the key override. Blume loads `.env` and
`.env.local` from the docs directory and its ancestors up to the repository root;
variables already set in the process environment take precedence.

PostHog loads only after the reader selects **Allow**. Before a choice and after
**Decline**, there are no PostHog SDK loads, pageviews or interaction requests.
After consent, pageviews (including client navigation), clicks, code copies and
search query text can be captured. Withdrawal opts out before Blume reloads the
page, clearing SDK persistence and stopping analytics. Session recordings and
person profiles are disabled. The footer's **Cookie settings** link lets readers
change their choice. Cookieless tracking is not enabled by this configuration.

The website and docs share the `widefleet-consent` preference cookie:
`granted` or `denied`, valid for 180 days, `Path=/`, `SameSite=Lax`, and `Secure`
on HTTPS. It is host-only: the website and `/docs` share the preference through
`Path=/`, so the reader answers once. Both analytics integrations also use
host-only cookies (`cross_subdomain_cookie: false`).
`apps/docs/public/consent.js` reconciles this preference with Blume before
PostHog initializes. The versioned `patches/blume@2.1.1.patch` lets scripts marked
`data-blume-consent="essential"` run before analytics consent; this is used only
to read and save the preference. It sends no analytics.

Local storage alone never authorizes analytics, and an expired cookie asks again. Open pages apply
changes when they regain focus or visibility. Cookie settings reopens the same
banner. Localhost shares the choice across ports. Other subdomains, including
previews, have independent cookies. Keep the preference
contract and banner copy consistent across the public website and docs.

Set `DOCS_POSTHOG_KEY` to an empty string to build without PostHog or the consent
banner. The docs `dev` script sets an empty key, disabling both analytics and the
consent banner even when a key is supplied by the shell or an `.env` file.
Local production previews include analytics unless disabled at build time, so disable
analytics or override the key with a test project's token before previewing.
Analytics configuration is embedded in the static build; changing it requires
rebuilding the docs.

Run the docs consent browser checks with
`pnpm exec playwright test --config apps/docs/playwright.config.ts`. They build
with a synthetic project token, load the public PostHog SDK and intercept all
PostHog browser requests locally. To use an already downloaded SDK file instead,
set `DOCS_POSTHOG_SDK_FIXTURE` to its path.

Run storage and migration regression checks with
`pnpm exec vitest run apps/docs/tests/consent.test.ts`. `DOCS_POSTHOG_HOST` overrides the
EU ingestion host for a local test receiver. Use a synthetic project token when
testing analytics.

The sidebar uses Blume's collapsible groups: groups start closed, with the current
page's parent expanded. The Blume patch also places the header CTA after search
and the theme toggle, keeping visual and keyboard order aligned. Preserve this
order when updating Blume.
