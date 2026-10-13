import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AssignmentStore,
  AuditStore,
  DeletionStore,
  DiskStore,
  JobFilter,
  JobStore,
  LockStore,
  ManifestStore,
  OutboxStore,
  PlanStore,
  PolicyStore,
  ProjectStore,
  Store
} from '../core/ports/store.js'
import type { DomainEvent, EventType } from '../core/shared/events.js'
import type {
  Assignment,
  AuditEntry,
  CapacityReading,
  DeletionOrder,
  DeletionTarget,
  Disk,
  Job,
  ManifestEntry,
  Plan,
  Policy,
  PolicyConfig,
  Project
} from '../core/shared/model.js'
import { runMigrations } from './migrations.js'

type Row = Record<string, SQLInputValue>
type Params = Record<string, SQLInputValue>

export type Cell = SQLInputValue | undefined

const text = (value: Cell): string => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? `${value}` : '')
const json = (value: unknown): string => JSON.stringify(value)
export const parse = <T>(value: Cell): T => JSON.parse(text(value)) as T
const parseNullable = <T>(value: Cell): T | null => (value === null || value === undefined ? null : parse<T>(value))
export const str = (value: Cell): string => text(value)
const strOrNull = (value: Cell): string | null => (value === null || value === undefined ? null : text(value))
export const num = (value: Cell): number => Number(value)

export class SqliteStore implements Store {
  readonly db: DatabaseSync
  readonly disks: DiskStore
  readonly projects: ProjectStore
  readonly assignments: AssignmentStore
  readonly policies: PolicyStore
  readonly jobs: JobStore
  readonly locks: LockStore
  readonly manifest: ManifestStore
  readonly plans: PlanStore
  readonly deletions: DeletionStore
  readonly outbox: OutboxStore
  readonly audit: AuditStore
  private depth = 0
  private pending: (() => void)[] = []
  private readonly paramNames = new Map<string, Set<string>>()

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `)
    runMigrations(this.db)
    this.disks = new SqliteDisks(this)
    this.projects = new SqliteProjects(this)
    this.assignments = new SqliteAssignments(this)
    this.policies = new SqlitePolicies(this)
    this.jobs = new SqliteJobs(this)
    this.locks = new SqliteLocks(this)
    this.manifest = new SqliteManifest(this)
    this.plans = new SqlitePlans(this)
    this.deletions = new SqliteDeletions(this)
    this.outbox = new SqliteOutbox(this)
    this.audit = new SqliteAudit(this)
  }

  // node:sqlite rejects unknown named parameters, so each statement gets only the ones it uses
  private bind(sql: string, params: Params): Params {
    let names = this.paramNames.get(sql)
    if (!names) {
      names = new Set([...sql.matchAll(/:(\w+)/g)].map((m) => m[1] as string))
      this.paramNames.set(sql, names)
    }
    const used = names
    return Object.fromEntries(Object.entries(params).filter(([key]) => used.has(key)))
  }

  run(sql: string, params: Params = {}): number {
    return Number(this.db.prepare(sql).run(this.bind(sql, params)).changes)
  }

  get(sql: string, params: Params = {}): Row | null {
    return this.db.prepare(sql).get(this.bind(sql, params)) ?? null
  }

  all(sql: string, params: Params = {}): Row[] {
    return this.db.prepare(sql).all(this.bind(sql, params))
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.depth++
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      this.depth--
      const callbacks = this.pending
      this.pending = []
      for (const callback of callbacks) callback()
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.depth--
      this.pending = []
      throw error
    }
  }

  afterCommit(fn: () => void): void {
    if (this.depth > 0) this.pending.push(fn)
    else fn()
  }

  close(): void {
    this.db.close()
  }
}

class SqliteDisks implements DiskStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): Disk {
    return {
      id: str(r.id),
      identityKey: str(r.identity_key),
      serial: strOrNull(r.serial),
      wwn: strOrNull(r.wwn),
      model: str(r.model),
      sizeBytes: num(r.size_bytes),
      bus: str(r.bus) as Disk['bus'],
      devicePath: str(r.device_path),
      mountPath: strOrNull(r.mount_path),
      connected: num(r.connected) === 1,
      health: str(r.health) as Disk['health'],
      healthReasons: parse(r.health_reasons),
      advisories: parse(r.advisories),
      smart: parseNullable(r.smart),
      capacityLow: num(r.capacity_low) === 1,
      firstSeenAt: str(r.first_seen_at),
      lastSeenAt: str(r.last_seen_at)
    }
  }

  private params(d: Disk): Params {
    return {
      id: d.id,
      identity_key: d.identityKey,
      serial: d.serial,
      wwn: d.wwn,
      model: d.model,
      size_bytes: d.sizeBytes,
      bus: d.bus,
      device_path: d.devicePath,
      mount_path: d.mountPath,
      connected: d.connected ? 1 : 0,
      health: d.health,
      health_reasons: json(d.healthReasons),
      advisories: json(d.advisories),
      smart: d.smart === null ? null : json(d.smart),
      capacity_low: d.capacityLow ? 1 : 0,
      first_seen_at: d.firstSeenAt,
      last_seen_at: d.lastSeenAt
    }
  }

  get(id: string): Disk | null {
    const row = this.s.get('SELECT * FROM disks WHERE id = :id', { id })
    return row && this.map(row)
  }

  findByIdentity(identityKey: string): Disk | null {
    const row = this.s.get('SELECT * FROM disks WHERE identity_key = :identityKey', { identityKey })
    return row && this.map(row)
  }

  list(): Disk[] {
    return this.s.all('SELECT * FROM disks ORDER BY first_seen_at, rowid').map((r) => this.map(r))
  }

  insert(disk: Disk): void {
    this.s.run(
      `INSERT INTO disks VALUES (:id, :identity_key, :serial, :wwn, :model, :size_bytes, :bus, :device_path, :mount_path,
        :connected, :health, :health_reasons, :advisories, :smart, :capacity_low, :first_seen_at, :last_seen_at)`,
      this.params(disk)
    )
  }

  update(disk: Disk): void {
    this.s.run(
      `UPDATE disks SET serial = :serial, wwn = :wwn, model = :model, size_bytes = :size_bytes, bus = :bus,
        device_path = :device_path, mount_path = :mount_path, connected = :connected, health = :health,
        health_reasons = :health_reasons, advisories = :advisories, smart = :smart, capacity_low = :capacity_low,
        last_seen_at = :last_seen_at WHERE id = :id`,
      this.params(disk)
    )
  }

  addReading(r: CapacityReading): void {
    this.s.run('INSERT OR REPLACE INTO capacity_readings VALUES (:disk_id, :at, :total_bytes, :used_bytes)', {
      disk_id: r.diskId,
      at: r.at,
      total_bytes: r.totalBytes,
      used_bytes: r.usedBytes
    })
  }

  readings(diskId: string, since: string): CapacityReading[] {
    return this.s
      .all('SELECT * FROM capacity_readings WHERE disk_id = :diskId AND at >= :since ORDER BY at', { diskId, since })
      .map((r) => ({ diskId: str(r.disk_id), at: str(r.at), totalBytes: num(r.total_bytes), usedBytes: num(r.used_bytes) }))
  }
}

class SqliteProjects implements ProjectStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): Project {
    return { id: str(r.id), name: str(r.name), createdAt: str(r.created_at), revision: num(r.revision) }
  }

  get(id: string): Project | null {
    const row = this.s.get('SELECT * FROM projects WHERE id = :id', { id })
    return row && this.map(row)
  }

  findByName(name: string): Project | null {
    const row = this.s.get('SELECT * FROM projects WHERE name = :name', { name })
    return row && this.map(row)
  }

  list(): Project[] {
    return this.s.all('SELECT * FROM projects ORDER BY created_at, rowid').map((r) => this.map(r))
  }

  insert(p: Project): void {
    this.s.run('INSERT INTO projects VALUES (:id, :name, :created_at, :revision)', {
      id: p.id,
      name: p.name,
      created_at: p.createdAt,
      revision: p.revision
    })
  }

  update(p: Project): void {
    this.s.run('UPDATE projects SET name = :name, revision = :revision WHERE id = :id', { id: p.id, name: p.name, revision: p.revision })
  }

  remove(id: string): void {
    this.s.run('DELETE FROM projects WHERE id = :id', { id })
  }
}

class SqliteAssignments implements AssignmentStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): Assignment {
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      diskId: str(r.disk_id),
      folder: str(r.folder),
      role: str(r.role) as Assignment['role'],
      label: str(r.label),
      createdAt: str(r.created_at),
      mirrorOf: strOrNull(r.mirror_of)
    }
  }

  get(id: string): Assignment | null {
    const row = this.s.get('SELECT * FROM assignments WHERE id = :id', { id })
    return row && this.map(row)
  }

  byProject(projectId: string): Assignment[] {
    return this.s.all('SELECT * FROM assignments WHERE project_id = :projectId ORDER BY created_at, rowid', { projectId }).map((r) => this.map(r))
  }

  byDisk(diskId: string): Assignment[] {
    return this.s.all('SELECT * FROM assignments WHERE disk_id = :diskId ORDER BY created_at, rowid', { diskId }).map((r) => this.map(r))
  }

  list(): Assignment[] {
    return this.s.all('SELECT * FROM assignments ORDER BY created_at, rowid').map((r) => this.map(r))
  }

  insert(a: Assignment): void {
    this.s.run(
      'INSERT INTO assignments (id, project_id, disk_id, folder, role, label, created_at, mirror_of) VALUES (:id, :project_id, :disk_id, :folder, :role, :label, :created_at, :mirror_of)',
      {
        id: a.id,
        project_id: a.projectId,
        disk_id: a.diskId,
        folder: a.folder,
        role: a.role,
        label: a.label,
        created_at: a.createdAt,
        mirror_of: a.mirrorOf ?? null
      }
    )
  }

  update(a: Assignment): void {
    this.s.run('UPDATE assignments SET folder = :folder, role = :role, label = :label, mirror_of = :mirror_of WHERE id = :id', {
      id: a.id,
      folder: a.folder,
      role: a.role,
      label: a.label,
      mirror_of: a.mirrorOf ?? null
    })
  }

  remove(id: string): void {
    this.s.run('DELETE FROM assignments WHERE id = :id', { id })
  }
}

class SqlitePolicies implements PolicyStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): Policy {
    return {
      ...parse<PolicyConfig>(r.config),
      id: str(r.id),
      projectId: str(r.project_id),
      createdAt: str(r.created_at),
      lastScheduledFor: strOrNull(r.last_scheduled_for),
      lastSuccessAt: strOrNull(r.last_success_at),
      lastVerifiedAt: strOrNull(r.last_verified_at),
      overdueSince: strOrNull(r.overdue_since)
    }
  }

  private params(p: Policy): Params {
    const { id, projectId, createdAt, lastScheduledFor, lastSuccessAt, lastVerifiedAt, overdueSince, ...config } = p
    return {
      id,
      project_id: projectId,
      config: json(config),
      created_at: createdAt,
      last_scheduled_for: lastScheduledFor,
      last_success_at: lastSuccessAt,
      last_verified_at: lastVerifiedAt,
      overdue_since: overdueSince
    }
  }

  get(id: string): Policy | null {
    const row = this.s.get('SELECT * FROM policies WHERE id = :id', { id })
    return row && this.map(row)
  }

  byProject(projectId: string): Policy[] {
    return this.s.all('SELECT * FROM policies WHERE project_id = :projectId ORDER BY created_at, rowid', { projectId }).map((r) => this.map(r))
  }

  list(): Policy[] {
    return this.s.all('SELECT * FROM policies ORDER BY created_at, rowid').map((r) => this.map(r))
  }

  insert(p: Policy): void {
    this.s.run(
      `INSERT INTO policies VALUES (:id, :project_id, :config, :created_at, :last_scheduled_for, :last_success_at,
        :last_verified_at, :overdue_since)`,
      this.params(p)
    )
  }

  update(p: Policy): void {
    this.s.run(
      `UPDATE policies SET config = :config, last_scheduled_for = :last_scheduled_for, last_success_at = :last_success_at,
        last_verified_at = :last_verified_at, overdue_since = :overdue_since WHERE id = :id`,
      this.params(p)
    )
  }

  // Its jobs stay in the history
  remove(id: string): void {
    this.s.run('DELETE FROM policy_locks WHERE policy_id = :id', { id })
    this.s.run('DELETE FROM policies WHERE id = :id', { id })
  }
}

class SqliteJobs implements JobStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): Job {
    return {
      id: str(r.id),
      kind: str(r.kind) as Job['kind'],
      status: str(r.status) as Job['status'],
      trigger: str(r.trigger) as Job['trigger'],
      policyId: strOrNull(r.policy_id),
      projectId: strOrNull(r.project_id),
      scheduledFor: strOrNull(r.scheduled_for),
      dryRun: num(r.dry_run) === 1,
      progress: parse(r.progress),
      result: parseNullable(r.result),
      error: parseNullable(r.error),
      requestedBy: str(r.requested_by),
      createdAt: str(r.created_at),
      startedAt: strOrNull(r.started_at),
      finishedAt: strOrNull(r.finished_at)
    }
  }

  private params(j: Job): Params {
    return {
      id: j.id,
      kind: j.kind,
      status: j.status,
      trigger: j.trigger,
      policy_id: j.policyId,
      project_id: j.projectId,
      scheduled_for: j.scheduledFor,
      dry_run: j.dryRun ? 1 : 0,
      progress: json(j.progress),
      result: j.result === null ? null : json(j.result),
      error: j.error === null ? null : json(j.error),
      requested_by: j.requestedBy,
      created_at: j.createdAt,
      started_at: j.startedAt,
      finished_at: j.finishedAt
    }
  }

  get(id: string): Job | null {
    const row = this.s.get('SELECT * FROM jobs WHERE id = :id', { id })
    return row && this.map(row)
  }

  list(filter: JobFilter = {}): Job[] {
    const where: string[] = []
    const params: Params = { limit: filter.limit ?? 200 }
    if (filter.policyId) {
      where.push('policy_id = :policyId')
      params.policyId = filter.policyId
    }
    if (filter.kind) {
      where.push('kind = :kind')
      params.kind = filter.kind
    }
    if (filter.status && filter.status.length > 0) {
      const names = filter.status.map((status, i) => {
        params[`status${i}`] = status
        return `:status${i}`
      })
      where.push(`status IN (${names.join(', ')})`)
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    return this.s.all(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT :limit`, params).map((r) => this.map(r))
  }

  insert(job: Job): void {
    this.s.run(
      `INSERT INTO jobs VALUES (:id, :kind, :status, :trigger, :policy_id, :project_id, :scheduled_for, :dry_run, :progress,
        :result, :error, :requested_by, :created_at, :started_at, :finished_at)`,
      this.params(job)
    )
  }

  update(job: Job): void {
    this.s.run(
      `UPDATE jobs SET status = :status, scheduled_for = :scheduled_for, progress = :progress, result = :result,
        error = :error, started_at = :started_at, finished_at = :finished_at WHERE id = :id`,
      this.params(job)
    )
  }
}

class SqliteLocks implements LockStore {
  constructor(private readonly s: SqliteStore) {}

  acquire(policyId: string, jobId: string, at: string): boolean {
    return this.s.run('INSERT OR IGNORE INTO policy_locks VALUES (:policyId, :jobId, :at)', { policyId, jobId, at }) === 1
  }

  release(policyId: string, jobId: string): void {
    this.s.run('DELETE FROM policy_locks WHERE policy_id = :policyId AND job_id = :jobId', { policyId, jobId })
  }

  holder(policyId: string): string | null {
    const row = this.s.get('SELECT job_id FROM policy_locks WHERE policy_id = :policyId', { policyId })
    return row ? str(row.job_id) : null
  }

  releaseAll(): string[] {
    const jobs = this.s.all('SELECT job_id FROM policy_locks').map((r) => str(r.job_id))
    this.s.run('DELETE FROM policy_locks')
    return jobs
  }
}

class SqliteManifest implements ManifestStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): ManifestEntry {
    return {
      destinationId: str(r.destination_id),
      sourceId: str(r.source_id),
      relPath: str(r.rel_path),
      size: num(r.size),
      mtimeMs: num(r.mtime_ms),
      sha256: strOrNull(r.sha256),
      copiedAt: str(r.copied_at)
    }
  }

  get(destinationId: string, sourceId: string, relPath: string): ManifestEntry | null {
    const row = this.s.get(
      'SELECT * FROM manifest WHERE destination_id = :destinationId AND source_id = :sourceId AND rel_path = :relPath',
      { destinationId, sourceId, relPath }
    )
    return row && this.map(row)
  }

  list(destinationId: string, sourceId?: string): ManifestEntry[] {
    const rows = sourceId
      ? this.s.all('SELECT * FROM manifest WHERE destination_id = :destinationId AND source_id = :sourceId ORDER BY rel_path', {
          destinationId,
          sourceId
        })
      : this.s.all('SELECT * FROM manifest WHERE destination_id = :destinationId ORDER BY source_id, rel_path', { destinationId })
    return rows.map((r) => this.map(r))
  }

  upsert(e: ManifestEntry): void {
    this.s.run('INSERT OR REPLACE INTO manifest VALUES (:destination_id, :source_id, :rel_path, :size, :mtime_ms, :sha256, :copied_at)', {
      destination_id: e.destinationId,
      source_id: e.sourceId,
      rel_path: e.relPath,
      size: e.size,
      mtime_ms: e.mtimeMs,
      sha256: e.sha256,
      copied_at: e.copiedAt
    })
  }

  remove(destinationId: string, sourceId: string, relPath: string): void {
    this.s.run('DELETE FROM manifest WHERE destination_id = :destinationId AND source_id = :sourceId AND rel_path = :relPath', {
      destinationId,
      sourceId,
      relPath
    })
  }
}

class SqlitePlans implements PlanStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): Plan {
    return {
      id: str(r.id),
      kind: str(r.kind) as Plan['kind'],
      projectId: strOrNull(r.project_id),
      status: str(r.status) as Plan['status'],
      payload: parse(r.payload),
      preview: parse(r.preview),
      createdAt: str(r.created_at),
      expiresAt: str(r.expires_at),
      decidedAt: strOrNull(r.decided_at),
      decidedBy: strOrNull(r.decided_by),
      createdBy: str(r.created_by)
    }
  }

  private params(p: Plan): Params {
    return {
      id: p.id,
      kind: p.kind,
      project_id: p.projectId,
      status: p.status,
      payload: json(p.payload),
      preview: json(p.preview),
      created_at: p.createdAt,
      expires_at: p.expiresAt,
      decided_at: p.decidedAt,
      decided_by: p.decidedBy,
      created_by: p.createdBy
    }
  }

  get(id: string): Plan | null {
    const row = this.s.get('SELECT * FROM plans WHERE id = :id', { id })
    return row && this.map(row)
  }

  insert(plan: Plan): void {
    this.s.run(
      `INSERT INTO plans VALUES (:id, :kind, :project_id, :status, :payload, :preview, :created_at, :expires_at,
        :decided_at, :decided_by, :created_by)`,
      this.params(plan)
    )
  }

  update(plan: Plan): void {
    this.s.run(
      `UPDATE plans SET status = :status, payload = :payload, preview = :preview, decided_at = :decided_at,
        decided_by = :decided_by WHERE id = :id`,
      this.params(plan)
    )
  }
}

class SqliteDeletions implements DeletionStore {
  constructor(private readonly s: SqliteStore) {}

  private target(r: Row): DeletionTarget {
    return {
      orderId: str(r.order_id),
      destinationId: str(r.destination_id),
      status: str(r.status) as DeletionTarget['status'],
      attempts: num(r.attempts),
      lastError: strOrNull(r.last_error),
      doneAt: strOrNull(r.done_at)
    }
  }

  private order(r: Row): DeletionOrder {
    const id = str(r.id)
    return {
      id,
      projectId: str(r.project_id),
      items: parse(r.items),
      createdAt: str(r.created_at),
      requestedBy: str(r.requested_by),
      status: str(r.status) as DeletionOrder['status'],
      targets: this.s.all('SELECT * FROM deletion_targets WHERE order_id = :id ORDER BY destination_id', { id }).map((t) => this.target(t))
    }
  }

  get(id: string): DeletionOrder | null {
    const row = this.s.get('SELECT * FROM deletion_orders WHERE id = :id', { id })
    return row && this.order(row)
  }

  byProject(projectId: string): DeletionOrder[] {
    return this.s
      .all('SELECT * FROM deletion_orders WHERE project_id = :projectId ORDER BY created_at, rowid', { projectId })
      .map((r) => this.order(r))
  }

  pendingTargets(): DeletionTarget[] {
    return this.s.all("SELECT * FROM deletion_targets WHERE status = 'pending' ORDER BY order_id, destination_id").map((r) => this.target(r))
  }

  insert(order: DeletionOrder): void {
    this.s.run('INSERT INTO deletion_orders VALUES (:id, :project_id, :items, :created_at, :requested_by, :status)', {
      id: order.id,
      project_id: order.projectId,
      items: json(order.items),
      created_at: order.createdAt,
      requested_by: order.requestedBy,
      status: order.status
    })
    for (const t of order.targets) {
      this.s.run('INSERT INTO deletion_targets VALUES (:order_id, :destination_id, :status, :attempts, :last_error, :done_at)', {
        order_id: t.orderId,
        destination_id: t.destinationId,
        status: t.status,
        attempts: t.attempts,
        last_error: t.lastError,
        done_at: t.doneAt
      })
    }
  }

  updateTarget(t: DeletionTarget): void {
    this.s.run(
      `UPDATE deletion_targets SET status = :status, attempts = :attempts, last_error = :last_error, done_at = :done_at
        WHERE order_id = :order_id AND destination_id = :destination_id`,
      {
        order_id: t.orderId,
        destination_id: t.destinationId,
        status: t.status,
        attempts: t.attempts,
        last_error: t.lastError,
        done_at: t.doneAt
      }
    )
  }

  setStatus(orderId: string, status: DeletionOrder['status']): void {
    this.s.run('UPDATE deletion_orders SET status = :status WHERE id = :orderId', { orderId, status })
  }
}

class SqliteOutbox implements OutboxStore {
  constructor(private readonly s: SqliteStore) {}

  private map(r: Row): DomainEvent {
    return {
      seq: num(r.seq),
      id: str(r.id),
      type: str(r.type) as EventType,
      occurredAt: str(r.occurred_at),
      payload: parse(r.payload)
    }
  }

  append(event: Omit<DomainEvent, 'seq'>): DomainEvent {
    const row = this.s.get('INSERT INTO outbox (id, type, occurred_at, payload) VALUES (:id, :type, :occurred_at, :payload) RETURNING seq', {
      id: event.id,
      type: event.type,
      occurred_at: event.occurredAt,
      payload: json(event.payload)
    })
    return { ...event, seq: num(row?.seq ?? 0) }
  }

  after(seq: number, limit: number, types?: EventType[]): DomainEvent[] {
    const params: Params = { seq, limit }
    let filter = ''
    if (types && types.length > 0) {
      filter = `AND type IN (${types.map((t, i) => ((params[`t${i}`] = t), `:t${i}`)).join(', ')})`
    }
    return this.s.all(`SELECT * FROM outbox WHERE seq > :seq ${filter} ORDER BY seq LIMIT :limit`, params).map((r) => this.map(r))
  }

  latestOfType(type: EventType, matches: (event: DomainEvent) => boolean): DomainEvent | null {
    for (const row of this.s.all('SELECT * FROM outbox WHERE type = :type ORDER BY seq DESC LIMIT 500', { type })) {
      const event = this.map(row)
      if (matches(event)) return event
    }
    return null
  }
}

class SqliteAudit implements AuditStore {
  constructor(private readonly s: SqliteStore) {}

  append(entry: Omit<AuditEntry, 'seq'>): AuditEntry {
    const row = this.s.get(
      'INSERT INTO audit (id, at, actor, action, target, details) VALUES (:id, :at, :actor, :action, :target, :details) RETURNING seq',
      { id: entry.id, at: entry.at, actor: entry.actor, action: entry.action, target: entry.target, details: json(entry.details) }
    )
    return { ...entry, seq: num(row?.seq ?? 0) }
  }

  after(seq: number, limit: number): AuditEntry[] {
    return this.s.all('SELECT * FROM audit WHERE seq > :seq ORDER BY seq LIMIT :limit', { seq, limit }).map((r) => ({
      seq: num(r.seq),
      id: str(r.id),
      at: str(r.at),
      actor: str(r.actor),
      action: str(r.action),
      target: str(r.target),
      details: parse(r.details)
    }))
  }
}
