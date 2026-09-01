import { copyFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type DatabaseMigration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

export type DatabaseMigrationSnapshot = (firstPendingVersion: number) => string | null;

type MigrationRow = { version: number; name: string };

/**
 * Runs append-only SQLite migrations. The successful-migration ledger is the
 * source of truth; the run table exists so an interrupted/failed startup is
 * diagnosable without guessing from a caught ALTER TABLE error.
 */
export class DatabaseMigrationRunner {
  constructor(
    private readonly db: DatabaseSync,
    private readonly createSnapshot: DatabaseMigrationSnapshot = () => null,
  ) {}

  migrate(migrations: readonly DatabaseMigration[]): void {
    this.validateMigrations(migrations);
    this.ensureLedger();

    const applied = this.db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as MigrationRow[];
    const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));
    for (const migration of migrations) {
      const existing = appliedByVersion.get(migration.version);
      if (existing && existing.name !== migration.name) {
        throw new Error(`SQLite migration version ${migration.version} is already recorded as ${existing.name}, not ${migration.name}`);
      }
    }

    const pending = migrations.filter((migration) => !appliedByVersion.has(migration.version));
    if (pending.length === 0) return;
    const snapshotPath = this.createSnapshot(pending[0].version);
    for (const migration of pending) this.applyMigration(migration, snapshotPath);
  }

  private ensureLedger(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        duration_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migration_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'applied', 'failed')),
        snapshot_path TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        duration_ms INTEGER
      );
    `);
  }

  private applyMigration(migration: DatabaseMigration, snapshotPath: string | null): void {
    const startedAt = Date.now();
    const result = this.db.prepare(`
      INSERT INTO schema_migration_runs (version, name, status, snapshot_path)
      VALUES (?, ?, 'running', ?)
    `).run(migration.version, migration.name, snapshotPath);
    const runId = Number(result.lastInsertRowid);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      migration.up(this.db);
      this.db.prepare("INSERT INTO schema_migrations (version, name, duration_ms) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, Date.now() - startedAt);
      this.db.exec("COMMIT");
      this.db.prepare(`
        UPDATE schema_migration_runs
        SET status = 'applied', completed_at = CURRENT_TIMESTAMP, duration_ms = ?
        WHERE id = ?
      `).run(Date.now() - startedAt, runId);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The migration may have failed before its transaction became active.
      }
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare(`
        UPDATE schema_migration_runs
        SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP, duration_ms = ?
        WHERE id = ?
      `).run(message, Date.now() - startedAt, runId);
      throw new Error(`SQLite migration ${migration.version} (${migration.name}) failed: ${message}`, { cause: error });
    }
  }

  private validateMigrations(migrations: readonly DatabaseMigration[]): void {
    let previousVersion = 0;
    for (const migration of migrations) {
      if (!Number.isInteger(migration.version) || migration.version <= previousVersion || !migration.name.trim()) {
        throw new Error("SQLite migrations must have unique, ascending positive versions and names");
      }
      previousVersion = migration.version;
    }
  }
}

/** Copies a checkpointed existing database so WAL content is included. */
export function createMigrationSnapshot(
  db: DatabaseSync,
  databasePath: string,
  firstPendingVersion: number,
  protectFile: (path: string) => void,
): string | null {
  if (!existsSync(databasePath) || statSync(databasePath).size === 0) return null;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const snapshotPath = join(
    dirname(databasePath),
    `${basename(databasePath, ".sqlite")}.before-migration-v${firstPendingVersion}-${randomUUID()}.sqlite`,
  );
  copyFileSync(databasePath, snapshotPath);
  protectFile(snapshotPath);
  return snapshotPath;
}
