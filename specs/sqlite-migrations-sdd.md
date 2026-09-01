# SQLite migrations SDD

## Context

`LocalStore` persisted schema changes by attempting `ALTER TABLE` on every
startup and treating any exception as "already migrated". That cannot tell a
legitimate old schema from a malformed or partially-upgraded database, gives no
history of what ran, and makes a failed upgrade difficult to diagnose.

## Goals

- Apply each schema/data migration exactly once, in ascending version order.
- Record successful migrations and all attempted migration runs locally.
- Make each migration atomic: a failure leaves that migration's changes absent.
- Before upgrading an existing database with pending migrations, create a
  consistent, private SQLite snapshot beside the database.
- Preserve compatibility with the historical schemas already supported by the
  store, including collaboration task and Codex-account table rebuilds.

## Non-goals

- Replacing SQLite, adding cloud backup/sync, or retroactively inventing a
  version for releases that predate this runner.
- Deleting snapshots automatically. They are intentionally a recovery aid;
  retention policy can be added separately.

## Design

`DatabaseMigrationRunner` owns two ledger tables:

| Table | Purpose |
| --- | --- |
| `schema_migrations` | authoritative, immutable record of successfully applied versions, names, timestamp, and duration |
| `schema_migration_runs` | operational audit log for every run, including failed runs, error text, and the pre-upgrade snapshot path |

The runner validates that registered migration versions are unique and strictly
increasing. For each unapplied migration it writes a `running` audit entry,
executes the migration and ledger insert inside `BEGIN IMMEDIATE` / `COMMIT`,
then marks that audit entry `applied`. On error it rolls back the transaction,
persists a `failed` audit result outside the rolled-back transaction, and stops
startup with the original failure context.

When an existing database has pending migrations, the store checkpoints WAL
first and copies the main database to a uniquely named
`*.before-migration-v{version}-*.sqlite` file. The file is protected using the
same private-file policy as the primary database. New databases do not receive
an unnecessary empty snapshot.

The initial migration set converts the previously implicit migrations into
three named versions:

1. rebuild legacy `collaboration_tasks` to support `returning` and
   `continuation_result`;
2. rebuild legacy `codex_accounts` into provider-neutral `accounts`;
3. add/backfill the remaining historical Store columns deterministically after
   checking `PRAGMA table_info` (rather than swallowing arbitrary SQL errors).

The existing baseline `CREATE TABLE IF NOT EXISTS` bootstrap stays in place.
This deliberately limits risk: old databases still first receive any missing
base tables, then the versioned runner repairs their historical variants.

## Acceptance criteria

1. A fresh `LocalStore` records all current migration versions, with no backup
   snapshot created.
2. A historical schema upgrades to the current Store API, records the migration
   versions/runs, and creates a readable private snapshot before changes.
3. A runner migration that throws leaves its in-migration DDL/data rolled back,
   records the failure, and does not mark that version applied.
4. Existing Store migration tests continue to pass.
5. Server typecheck and test suite pass, and the README no longer claims a
   formal migration tool is absent.

## Rollout and recovery

The first startup after this release may create a single snapshot for an
existing database. If migration startup fails, stop the server, retain the
original database and the snapshot, and use the recorded failed migration run
to diagnose before retrying. Because the failing migration is rolled back, a
corrected release can retry it safely.
