# Gmail connector

A standalone Widefleet connector using Better Auth Generic OAuth and D1. Copy this
directory into your own project; it has no dependencies on Widefleet workspace
packages. Its browser page links a Google account to the verified Widefleet
caller. Apps use the connector's normal RPC methods to read Gmail.

[Set up the connector and adapt it for another provider](https://widefleet.com/docs/guides/gmail-connector).

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Tests use synthetic identities and provider responses in a local Worker with D1.
They do not contact Google. `pnpm build` checks bundling; deployment uses
`widefleet connector deploy` with `wrangler.jsonc`.
