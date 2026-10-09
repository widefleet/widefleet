# Documentation hosting

This app owns the documentation build, deployment, public Cloudflare routes and
root discovery aliases. Keep those responsibilities together here.

- `docs/` inside this app contains the canonical documentation for app creators
  and installation operators. Put self-hosting and operational reference here.
- Contributor setup, internal tests, release publishing and website maintenance
  belong in the repository-root `docs/`. Split mixed pages; link instead of copying.
- Keep user journeys inside the website. When moving a page, update its incoming
  links, navigation and any packaging inputs; validate and build the docs.

- `wrangler.jsonc` routes the six reserved prefixes on `widefleet.com` to the
  docs Worker. Keep the hostname exact and other website paths outside these routes.
- `scripts/prepare-assets.ts` mounts the build under `/docs` and generates static
  asset rewrites for `/SKILL.md` and the four explicit `/.well-known` aliases.
  Preserve the generated content types and CORS headers on the root aliases.
- Production docs do not require a website Worker or a `DOCS` service binding.
  The website owns its remaining paths, root robots policy and sitemap index.
- Docs branch Previews live at `<preview-name>.docs.widefleet.com/docs`. Preserve
  their hostname-scoped `noindex` rule and the production `/docs` base path.
- The dev-only integration in `blume.config.ts` lets Vite own the `/docs` prefix
  for pages, modules, fonts and hot reload. Preserve same-origin development
  through an optional website proxy without changing production asset paths.
- After routing or asset preparation changes, run
  `pnpm exec vitest run apps/docs/tests/routing.test.ts`, the docs build and docs
  typecheck, plus formatting and type-aware lint for changed files.

[Documentation site maintenance](../../docs/documentation-site.md) documents route
ownership, Preview links and deployment order. Keep these details there; the root
README links to the guide.
