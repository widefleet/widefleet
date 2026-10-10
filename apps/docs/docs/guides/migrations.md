---
title: Database migrations
description: Apply D1 schema migrations explicitly and recover from failures.
---

Widefleet runs SQL migrations through explicit CLI commands. Write SQL yourself or generate it with an ORM such as Drizzle. `widefleet deploy` does not apply migrations.

The app must already have a successfully deployed D1 binding and its fleet must be running. For a new database, first deploy a version declaring the binding that can start without the new schema. Then apply migrations and deploy the code that uses the schema. For an existing database, keep migrations compatible with the currently serving code until the next deploy completes.

## Commands

From the app project, using your ordinary Widefleet login:

```sh
widefleet migrations list DB
widefleet migrations apply DB
```

`DB` selects a binding or an unambiguous `database_name` in `wrangler.jsonc`. `--config PATH` selects another configuration; paths inside it are relative to that file. `--app NAME_OR_UUID` selects an existing app, including an isolated preview. The local database identity must match the selected app's deployed binding. An app owner, granted creator or administrator can run migrations with `platform:write`; reading operation status also requires `platform:read`.

Both commands wait for the agent and print each local file's applied or pending status. `--json` emits one operation result; redirected stdout also uses JSON. Progress and the operation ID go to stderr. Failures exit nonzero. `list` reads the D1 schema and history without creating a migration table or applying SQL.

## File configuration

By default, Widefleet reads `migrations/*.sql` and records names in `d1_migrations`. The table has the same `id`, `name` and `applied_at` columns as celld/Wrangler migration history.

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "app-data",
      "database_id": "app-data",
      "migrations_dir": "migrations",
      "migrations_pattern": "migrations/*.sql",
      "migrations_table": "d1_migrations",
    },
  ],
}
```

The pattern is relative to the configuration file and must begin with `migrations_dir/`. Supported wildcards are `*` within a path segment and `**` as a complete segment. Other glob syntax is rejected. Migration directories must stay inside the app project and cannot contain symlinks.

Files are ordered by the numeric prefix of their relative path, then by the full path. For example, `2_initial.sql` precedes `10_add_notes.sql`. Migration names are the full paths relative to `migrations_dir`, with `/` separators. Use letters, numbers, underscores, hyphens and dots in path segments. Each operation supports up to 1000 files, 1 MiB of UTF-8 SQL per file and 8 MiB of SQL in total.

## Drizzle v1

Configure Drizzle's output directory as `drizzle`. In the corresponding D1 declaration, set:

```jsonc
{
  "migrations_dir": "drizzle",
  "migrations_pattern": "drizzle/**/migration.sql",
}
```

Then generate, review and commit migrations before applying them:

```sh
pnpm exec drizzle-kit generate
widefleet migrations list DB
widefleet migrations apply DB
```

Widefleet discovers files such as `drizzle/20261008120000_add_notes/migration.sql`. Snapshot JSON files are ignored, and SQL statement-breakpoint comments remain valid SQL comments. Drizzle is optional. Direct `drizzle-kit migrate` access to Widefleet is not provided.

## Failure and retry behavior

Migration requests are stored as immutable, SHA-256-addressed JSON artifacts in the existing app artifact storage. Each job stores only the artifact's checksum and byte size, not SQL. The control plane finishes the upload before queuing the job. The agent downloads the artifact through the same authenticated, lease-scoped mechanism as app modules and checks its size and checksum before executing any SQL. Identical requests reuse the stored content. Artifacts belong to the app and are removed by the existing app-deletion cleanup.

The agent processes migration jobs in the same ordered fleet queue as deployments. Each file and its history row execute in one celld D1 transaction. If a file fails, its schema changes, data changes and history row roll back; earlier successful files remain applied and later files are not attempted. Correct the pending file and run `apply` again. A lost management acknowledgment can be retried using the D1 history without executing committed files again.

On a heartbeat failure or graceful interruption, the agent waits for the current SQL command to finish and starts no further SQL before reporting failure. That file may have committed; retrying checks its history before deciding whether to execute it again.

Applied migrations are identified by name, not by content checksum. Do not edit or rename an applied file, move it into another subdirectory, or switch history tables: these actions do not represent a new, safe migration. Add a new file for subsequent changes. The history table is reserved for the migration runner. If a database was already migrated by another runner, reconcile its history before switching; Drizzle's `__drizzle_migrations` is a different history format.

## Management API

`POST /api/v1/apps/{appId}/migrations` accepts `action` (`list` or `apply`), `database` (binding name), `databaseId` (the configured ID, or database name when no ID is configured), `table` and `files`. Each file has a `name`; `sql` is required for `apply` and omitted for `list`. Supply a UUID `Idempotency-Key` header. Repeating the same request returns the original job; changing its content with the same key returns a conflict.

Poll `GET /api/v1/apps/{appId}/migrations/{jobId}` for `state`, `message` and `entries`. Jobs do not activate code or update network/connector permissions. The agent checks the current runtime binding again before executing, so a queued migration cannot silently follow a binding that has changed identity.
