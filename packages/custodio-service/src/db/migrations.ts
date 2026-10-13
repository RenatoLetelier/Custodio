import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE disks (
        id TEXT PRIMARY KEY,
        identity_key TEXT NOT NULL UNIQUE,
        serial TEXT,
        wwn TEXT,
        model TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        bus TEXT NOT NULL,
        device_path TEXT NOT NULL,
        mount_path TEXT,
        connected INTEGER NOT NULL,
        health TEXT NOT NULL,
        health_reasons TEXT NOT NULL,
        advisories TEXT NOT NULL,
        smart TEXT,
        capacity_low INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE capacity_readings (
        disk_id TEXT NOT NULL REFERENCES disks(id),
        at TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL,
        PRIMARY KEY (disk_id, at)
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revision INTEGER NOT NULL
      );

      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        disk_id TEXT NOT NULL REFERENCES disks(id),
        folder TEXT NOT NULL,
        role TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (disk_id, folder)
      );

      CREATE TABLE policies (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_scheduled_for TEXT,
        last_success_at TEXT,
        last_verified_at TEXT,
        overdue_since TEXT
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        policy_id TEXT,
        project_id TEXT,
        scheduled_for TEXT,
        dry_run INTEGER NOT NULL,
        progress TEXT NOT NULL,
        result TEXT,
        error TEXT,
        requested_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX jobs_policy ON jobs (policy_id, created_at);

      CREATE TABLE policy_locks (
        policy_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );

      CREATE TABLE manifest (
        destination_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        sha256 TEXT,
        copied_at TEXT NOT NULL,
        PRIMARY KEY (destination_id, source_id, rel_path)
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        preview TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        created_by TEXT NOT NULL
      );

      CREATE TABLE deletion_orders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE deletion_targets (
        order_id TEXT NOT NULL REFERENCES deletion_orders(id),
        destination_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        done_at TEXT,
        PRIMARY KEY (order_id, destination_id)
      );

      CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        details TEXT NOT NULL
      );

      CREATE TABLE idempotency (
        actor TEXT NOT NULL,
        key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor, key)
      );
    `
  },
  {
    version: 2,
    name: 'mirror_paths',
    sql: `ALTER TABLE assignments ADD COLUMN mirror_of TEXT;`
  }
]

export function runMigrations(db: DatabaseSync, list: Migration[] = migrations): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
  const appliedNow: number[] = []

  for (const migration of [...list].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      record.run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    appliedNow.push(migration.version)
  }
  return appliedNow
}
