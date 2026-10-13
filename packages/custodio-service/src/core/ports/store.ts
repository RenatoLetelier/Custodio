import type { DomainEvent, EventType } from '../shared/events.js'
import type {
  Assignment,
  AuditEntry,
  CapacityReading,
  DeletionOrder,
  DeletionTarget,
  Disk,
  Job,
  JobStatus,
  ManifestEntry,
  Plan,
  Policy,
  Project
} from '../shared/model.js'

// Persistence is synchronous (SQLite in-process); async work happens outside transactions

export interface DiskStore {
  get(id: string): Disk | null
  findByIdentity(identityKey: string): Disk | null
  list(): Disk[]
  insert(disk: Disk): void
  update(disk: Disk): void
  addReading(reading: CapacityReading): void
  readings(diskId: string, since: string): CapacityReading[]
}

export interface ProjectStore {
  get(id: string): Project | null
  findByName(name: string): Project | null
  list(): Project[]
  insert(project: Project): void
  update(project: Project): void
  remove(id: string): void
}

export interface AssignmentStore {
  get(id: string): Assignment | null
  byProject(projectId: string): Assignment[]
  byDisk(diskId: string): Assignment[]
  list(): Assignment[]
  insert(assignment: Assignment): void
  update(assignment: Assignment): void
  remove(id: string): void
}

export interface PolicyStore {
  get(id: string): Policy | null
  byProject(projectId: string): Policy[]
  list(): Policy[]
  insert(policy: Policy): void
  update(policy: Policy): void
  remove(id: string): void
}

export interface JobFilter {
  policyId?: string
  status?: JobStatus[]
  kind?: Job['kind']
  limit?: number
}

export interface JobStore {
  get(id: string): Job | null
  list(filter?: JobFilter): Job[]
  insert(job: Job): void
  update(job: Job): void
}

export interface LockStore {
  acquire(policyId: string, jobId: string, at: string): boolean
  release(policyId: string, jobId: string): void
  holder(policyId: string): string | null
  releaseAll(): string[]
}

export interface ManifestStore {
  get(destinationId: string, sourceId: string, relPath: string): ManifestEntry | null
  list(destinationId: string, sourceId?: string): ManifestEntry[]
  upsert(entry: ManifestEntry): void
  remove(destinationId: string, sourceId: string, relPath: string): void
}

export interface PlanStore {
  get(id: string): Plan | null
  insert(plan: Plan): void
  update(plan: Plan): void
}

export interface DeletionStore {
  get(id: string): DeletionOrder | null
  byProject(projectId: string): DeletionOrder[]
  pendingTargets(): DeletionTarget[]
  insert(order: DeletionOrder): void
  updateTarget(target: DeletionTarget): void
  setStatus(orderId: string, status: DeletionOrder['status']): void
}

export interface OutboxStore {
  append(event: Omit<DomainEvent, 'seq'>): DomainEvent
  after(seq: number, limit: number, types?: EventType[]): DomainEvent[]
  latestOfType(type: EventType, matches: (event: DomainEvent) => boolean): DomainEvent | null
}

export interface AuditStore {
  append(entry: Omit<AuditEntry, 'seq'>): AuditEntry
  after(seq: number, limit: number): AuditEntry[]
}

export interface Store {
  disks: DiskStore
  projects: ProjectStore
  assignments: AssignmentStore
  policies: PolicyStore
  jobs: JobStore
  locks: LockStore
  manifest: ManifestStore
  plans: PlanStore
  deletions: DeletionStore
  outbox: OutboxStore
  audit: AuditStore
  transaction<T>(fn: () => T): T
  // Runs after the current transaction commits, or right away outside one
  afterCommit(fn: () => void): void
}
