---
title: Database migrations
description: Apply D1 schema migrations explicitly and recover from failures.
lastModified: 2026-11-18
---

Change your app's D1 schema with SQL migration files. You apply migrations
separately from `widefleet deploy`, so you decide when schema changes run. Write
SQL yourself or generate it with an ORM such as Drizzle.

You need a Widefleet login with management access to the app: app owner, granted
creator or administrator, with the `platform:write` scope (`platform:read` to read
operation status). The app must already be deployed with the D1 binding.

## Apply your first migration

This example adds a `tasks` table to the database bound as `DB`.

1. Create `migrations/0001_create_tasks.sql` in the app project:

   ```sql
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   ```

2. Check which files are pending:

   ```sh
   widefleet migrations list DB
   ```

   ```text
   pending	0001_create_tasks.sql
   ```

3. Apply them:

   ```sh
   widefleet migrations apply DB
   ```

4. Deploy the code that uses the new table:

   ```sh
   widefleet deploy
   ```

5. Run `widefleet migrations list DB` again. The file now shows as `applied`. Open
   the app and check the feature that uses `tasks`.

For a new database, first deploy a version that declares the binding and can start
without the new schema, then follow these steps. For an existing database, keep
each migration compatible with the code currently serving until the next deploy
completes.

## Command options

`DB` selects a binding or an unambiguous `database_name` in `wrangler.jsonc`.

| Option               | Effect                                                                |
| -------------------- | --------------------------------------------------------------------- |
| `--config PATH`      | Use another configuration; paths inside it are relative to that file. |
| `--app NAME_OR_UUID` | Select an existing app, including an isolated preview.                |
| `--json`             | Print one JSON operation result. Redirected output also uses JSON.    |

Both commands wait for the operation and print each local file as `applied` or
`pending`. Progress and the operation ID go to stderr; failures exit nonzero. `list`
only reads the schema and history; it creates no table and runs no SQL. The local
database identity must match the selected app's deployed binding.

## File configuration

By default, Widefleet reads `migrations/*.sql` and records applied names in the
`d1_migrations` table, which has the same `id`, `name` and `applied_at` columns as
Wrangler's migration history. To change the defaults:

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

The pattern is relative to the configuration file and must begin with
`migrations_dir/`. Use `*` within a path segment and `**` as a complete segment;
other glob syntax is rejected. Migration directories must stay inside the app
project and cannot contain symlinks.

Files run in order of the numeric prefix of their relative path, then by full path:
`2_initial.sql` runs before `10_add_notes.sql`. A migration's name is its path
relative to `migrations_dir`, with `/` separators. Use letters, numbers,
underscores, hyphens and dots in path segments. Each operation supports up to 1000
files, 1 MiB of UTF-8 SQL per file and 8 MiB of SQL in total.

## Drizzle v1

Configure Drizzle's output directory as `drizzle`. In the corresponding D1
declaration, set:

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

Widefleet discovers files such as `drizzle/20261008120000_add_notes/migration.sql`.
Snapshot JSON files are ignored, and statement-breakpoint comments remain valid SQL
comments. Use `drizzle-kit generate` to create the SQL and `widefleet migrations apply`
to run it.

## If a migration fails

Migrations run in order with deployments. Each file runs in its own transaction. If
a file fails, its changes roll back, earlier files stay applied and later files
wait. Fix the failing file and run `apply` again; applied files are skipped.

Widefleet identifies applied migrations by name, not by content. Never edit or
rename an applied file, move it into another subdirectory or switch history
tables; add a new file for each further change. The history table is reserved for
the migration runner. If another runner already migrated the database, reconcile
its history before switching; Drizzle's `__drizzle_migrations` uses a different
format.

To run migrations from scripts or CI without the CLI, use the
[management API](/reference/api).
