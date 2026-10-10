# Documentation website

Build, preview and maintain the public documentation site. Use the toolchain from [development](development.md) and run commands from the repository root. Content placement and release timing follow the [documentation rules](../AGENTS.md#documentation-scope).

## Local development

The website source is `apps/docs/docs/`. Use site routes in published pages, public `https://widefleet.com/docs/...` URLs in repository guides, and each section's `meta.ts` for navigation. When moving pages, update incoming links and packaging inputs: [CLI packaging](../tools/package-cli.ts) reads the public CLI installation guide to generate the release README.

Start the docs at `http://localhost:4321/docs`:

```sh
pnpm --filter @platform/docs run dev
```

The dev server keeps pages, assets and hot reload under `/docs`. An optional website dev server can proxy that prefix, including WebSockets, to `http://127.0.0.1:4321` without rewriting paths. Start the servers separately. The [development integration](../apps/docs/blume.config.ts) preserves the public base for component URLs while letting Vite handle the prefix once; keep this distinction when upgrading Blume.

`DOCS_WEBSITE_URL` controls website and legal-page destinations. It defaults to `http://localhost:5178` in development and `https://widefleet.com` in production builds. Override it for another local website origin.

To validate content and preview production routing without analytics:

```sh
pnpm --filter @platform/docs run validate
DOCS_POSTHOG_KEY= pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run preview --port 4321
```

The preview uses local Wrangler and the build in `apps/docs/dist`. Stop the dev server before building or previewing on the same port. To check content while the dev server is running, use `pnpm --filter @platform/docs run build --isolated`; output goes to `.blume-verify/dist`. Use a normal build and production preview to inspect generated discovery files, which the dev server and isolated build omit.

## Hosting under /docs

The [Blume configuration](../apps/docs/blume.config.ts) sets the public origin and `/docs` base. The [Wrangler configuration](../apps/docs/wrangler.jsonc) owns the docs Worker's routes. The website retains its `widefleet.com` Custom Domain and proxied DNS record; the docs routes take precedence only for their reserved prefixes. Production docs traffic needs no website proxy or service binding.

Keep the hostname exact. Route wildcards include query strings and also reserve suffixes such as `/docs-missing`, which must reach the docs Worker and return its 404. Unrelated `/.well-known/*` paths remain with the website. The separate `docs.widefleet.com` Custom Domain is for docs Previews; `workers.dev` URLs are disabled.

Astro's base setting changes URLs without nesting build output. The [asset preparation script](../apps/docs/scripts/prepare-assets.ts) therefore mounts the build beneath `/docs` and keeps response rules at the asset root. Root discovery aliases need their own response headers because their rewrites preserve the requested URL. New aliases require matching changes to the explicit Wrangler routes, asset preparation and [routing tests](../apps/docs/tests/routing.test.ts).

The website owns the origin's `/robots.txt`, `/llms.txt` and sitemap index, which includes `/docs/sitemap.xml`. The docs build must not introduce a competing robots policy. Generated discovery content belongs to the docs build; do not copy it into the website repository. Its OpenAPI document describes the documentation API, not Widefleet's platform API.

When replacing website forwarding with these routes, deploy and verify the docs routes first, including `/docs`, assets, `/SKILL.md` and the root discovery manifests. Only then remove the website's forwarding hook, alias rewrites and `DOCS` bindings. Website Preview links must point to production docs or a selected docs Preview; they cannot assume their own host serves `/docs`.

## Deployment and Previews

Keep routing and hosting changes in versioned configuration and use the approved merge/deploy process. For an explicitly approved manual production deployment, authenticate Wrangler, rebuild without local URL overrides, then run:

```sh
pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run deploy
```

Deployment commands prepare the existing build before uploading it. They do not rebuild or change embedded analytics settings.

For a docs Preview without analytics:

```sh
DOCS_POSTHOG_KEY= pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run deploy:preview
pnpm --filter @platform/docs run deploy:preview --name review
```

The Preview name defaults to the current Git branch; `--name review` serves `https://review.docs.widefleet.com/docs`. Apply the custom-domain configuration through the approved production deployment process first, ensure the certificate covers `*.docs.widefleet.com`, and configure Cloudflare Access to allow public Previews if desired. Deploying the project does not change Access policies.

The prepared assets add `X-Robots-Tag: noindex` only on `*.docs.widefleet.com`, including named and unique deployment URLs. Preserve that hostname scope so production docs remain indexable. Each docs Preview serves its own discovery aliases; production zone routes do not target Preview deployments.

In Cloudflare Workers Builds, keep the root directory at `/` and use:

| Setting         | Command                                           |
| --------------- | ------------------------------------------------- |
| Build command   | `pnpm --filter @platform/docs run build`          |
| Deploy command  | `pnpm --filter @platform/docs run deploy`         |
| Preview command | `pnpm --filter @platform/docs run deploy:preview` |

Set `DOCS_POSTHOG_KEY` to an empty string in the Preview build environment. This builds once before the selected deployment command runs.

For local Cloudflare routing checks against an existing build:

```sh
pnpm --filter @platform/docs run prepare:deploy
pnpm --filter @platform/docs exec wrangler dev --port 8788
```

Open `http://localhost:8788/docs` and `http://localhost:8788/SKILL.md`. The docs Worker serves them independently of the website.

## Shared analytics consent

The website and docs share the host-only `widefleet-consent` cookie: `granted` or `denied`, valid for 180 days, `Path=/`, `SameSite=Lax`, and `Secure` on HTTPS. This lets readers answer once across the website and `/docs`. Localhost shares the choice across ports; other subdomains, including Previews, have independent cookies. Keep the preference contract and banner copy consistent across both sites.

The [consent bridge](../apps/docs/public/consent.js) must reconcile that cookie before PostHog initializes. Local storage alone never authorizes analytics; an absent or expired preference asks again. Withdrawal must stop capture before Blume reloads, and open pages must apply changed preferences when they regain focus or visibility.

The [Blume patch](../patches/blume@2.1.1.patch) allows the preference bridge to run before analytics consent. That exception is only for reading and saving the preference, never for sending analytics. Preserve the ordering and host-only analytics cookies when updating Blume or PostHog.

Analytics settings are embedded at build time. `DOCS_POSTHOG_KEY` overrides the configured public browser project token; never use a personal API key. An explicitly empty key removes analytics and the consent banner. The dev script always supplies an empty key. For local production previews, disable analytics or use a synthetic test project's token.

See the [environment template](../apps/docs/.env.example) for URL and ingestion-host overrides. Blume loads `.env` and `.env.local` from the docs directory and its ancestors to the repository root; process environment values take precedence.

## Verify maintenance changes

For content moves, run validation and a build as shown above. For routing or asset preparation changes:

```sh
pnpm exec vitest run apps/docs/tests/routing.test.ts
pnpm --filter @platform/docs run build
pnpm --filter @platform/docs run typecheck
```

The routing test uses local Workers and synthetic assets to check website/docs ownership, root aliases, response headers and Preview indexing. Run formatting and type-aware lint for changed code as required by the [contributor checks](../AGENTS.md#checks).

For consent or Blume patch changes:

```sh
pnpm exec vitest run apps/docs/tests/consent.test.ts
pnpm exec playwright test --config apps/docs/playwright.config.ts
```

The browser checks build with a synthetic project token and intercept PostHog event requests locally. They download the public SDK; set `DOCS_POSTHOG_SDK_FIXTURE` to an existing SDK file to avoid that download. `DOCS_POSTHOG_HOST` can point to a local test receiver.

Before publication, confirm that the preview serves the changed pages and discovery endpoints with the expected headers, and that consent changes produce no analytics before consent or after withdrawal. Follow the [documentation release rules](../AGENTS.md#documentation-pull-requests-and-releases) for publication timing.
