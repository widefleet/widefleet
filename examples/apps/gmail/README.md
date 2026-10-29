# Gmail app

Connect a personal Google account and read Gmail from Widefleet apps. The example
includes a connection page, Better Auth OAuth and D1 storage.

[Set up the app](https://widefleet.com/docs/guides/gmail-app).

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Tests use local D1 and synthetic provider responses. Deploy with
`widefleet deploy`.
