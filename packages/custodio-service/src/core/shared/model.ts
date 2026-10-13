export type Health = 'green' | 'yellow' | 'red' | 'unknown'
export type Role = 'storage' | 'backup'
export type BusType = 'usb' | 'sata' | 'nvme' | 'sas' | 'other'

export interface Notice {
  code: string
  message: string
  attribute?: number
  value?: number
}

export interface SmartSnapshot {
  passed: boolean | null
  attributes: Record<string, number>
  temperatureC: number | null
  powerOnHours: number | null
}

export interface Disk {
  id: string
  identityKey: string
  serial: string | null
  wwn: string | null
  model: string
  sizeBytes: number
  bus: BusType
  devicePath: string
  mountPath: string | null
  connected: boolean
  health: Health
  healthReasons: Notice[]
  advisories: Notice[]
  smart: SmartSnapshot | null
  capacityLow: boolean
  firstSeenAt: string
  lastSeenAt: string
}

export interface CapacityReading {
  diskId: string
  at: string
  totalBytes: number
  usedBytes: number
}

export interface Project {
  id: string
  name: string
  createdAt: string
  revision: number
}

export interface Assignment {
  id: string
  projectId: string
  diskId: string
  // Relative to the volume root, always with forward slashes ("" is the root itself)
  folder: string
  role: Role
  label: string
  createdAt: string
  // A backup folder that keeps the paths of this one source (D:\lc\prod copied to E:\lc\prod); null for a shared one
  mirrorOf?: string | null
}

export type BackupMode = 'append' | 'retention' | 'mirror'

export interface TimeWindow {
  start: string
  end: string
}

export interface PolicyConfig {
  name: string
  sources: string[]
  destinations: string[]
  cron: string
  timezone: string
  mode: BackupMode
  retentionDays: number
  maxDeletePercent: number
  mirrorConfirmed: boolean
  maxMegabytesPerSecond: number | null
  window: TimeWindow | null
  verifySamplePercent: number
  verifyEveryHours: number
  paused: boolean
}

export interface PolicyState {
  lastScheduledFor: string | null
  lastSuccessAt: string | null
  lastVerifiedAt: string | null
  overdueSince: string | null
}

export interface Policy extends PolicyConfig, PolicyState {
  id: string
  projectId: string
  createdAt: string
}

export type JobKind = 'backup' | 'verification' | 'inventory_scan' | 'deletion' | 'repair'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'
export type JobTrigger = 'manual' | 'schedule' | 'catch_up'

// What a backup is doing (listing what to copy, checking what the destination already has, copying), or a verification re-reading copies
export type JobPhase = 'scanning' | 'checking' | 'copying' | 'verifying'

export interface JobProgress {
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  phase?: JobPhase
}

export interface JobError {
  code: string
  message: string
  details?: unknown
}

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  trigger: JobTrigger
  policyId: string | null
  projectId: string | null
  // The disk a repair works on
  diskId: string | null
  scheduledFor: string | null
  dryRun: boolean
  progress: JobProgress
  result: Record<string, unknown> | null
  error: JobError | null
  requestedBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  // Set when someone asks to cancel; the job stops at the next safe point (the file being copied is never left half done)
  cancelRequestedAt: string | null
}

export interface ManifestEntry {
  destinationId: string
  sourceId: string
  relPath: string
  size: number
  mtimeMs: number
  sha256: string | null
  copiedAt: string
}

export type PlanKind = 'assignments' | 'deletion' | 'repair' | 'setup' | 'removal'
export type PlanStatus = 'pending' | 'confirmed' | 'expired'

export interface PlanPreview {
  summary: string
  lines: string[]
  movesData: boolean
  deletesData: boolean
  bytesToCopy: number
  filesToDelete: number
}

export interface Plan {
  id: string
  kind: PlanKind
  projectId: string | null
  status: PlanStatus
  payload: Record<string, unknown>
  preview: PlanPreview
  createdAt: string
  expiresAt: string
  decidedAt: string | null
  decidedBy: string | null
  createdBy: string
}

export interface DeletionItem {
  sourceId: string
  path: string
}

export type DeletionTargetStatus = 'pending' | 'done'

export interface DeletionTarget {
  orderId: string
  destinationId: string
  status: DeletionTargetStatus
  attempts: number
  lastError: string | null
  doneAt: string | null
}

export interface DeletionOrder {
  id: string
  projectId: string
  items: DeletionItem[]
  createdAt: string
  requestedBy: string
  status: 'pending' | 'completed'
  targets: DeletionTarget[]
}

export interface AuditEntry {
  seq: number
  id: string
  at: string
  actor: string
  action: string
  target: string
  details: Record<string, unknown>
}
