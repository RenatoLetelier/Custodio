// Shapes of the /v1 API as described in openapi.yaml (only what the interface uses)

export type Health = 'green' | 'yellow' | 'red' | 'unknown'
export type Role = 'storage' | 'backup'

export interface Notice {
  code: string
  message: string
  attribute?: number
  value?: number
}

export interface Capacity {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  freePercent: number
  daysUntilFull: number | null
}

export interface Disk {
  id: string
  serial: string | null
  wwn: string | null
  model: string
  sizeBytes: number
  bus: string
  devicePath: string
  mountPath: string | null
  connected: boolean
  state: 'unassigned' | 'assigned'
  health: Health
  healthReasons: Notice[]
  advisories: Notice[]
  smart: { passed: boolean | null; attributes: Record<string, number>; temperatureC: number | null; powerOnHours: number | null } | null
  capacity: Capacity | null
  capacityLow: boolean
  assignments: { assignmentId: string; projectId: string; folder: string; role: Role; label: string }[]
  firstSeenAt: string
  lastSeenAt: string
}

export interface Overview {
  status: Health
  reasons: string[]
  disks: { total: number; connected: number; unassigned: number }
  space: { totalBytes: number; freeBytes: number }
  lastBackup: { id: string; policyId: string | null; status: string; finishedAt: string | null } | null
  nextBackup: { policyId: string; at: string } | null
}

export interface Assignment {
  id: string
  projectId: string
  diskId: string
  folder: string
  role: Role
  label: string
  createdAt: string
}

export interface Policy {
  id: string
  projectId: string
  name: string
  sources: string[]
  destinations: string[]
  cron: string
  timezone: string
  mode: 'append' | 'retention' | 'mirror'
  retentionDays: number
  maxDeletePercent: number
  mirrorConfirmed: boolean
  maxMegabytesPerSecond: number | null
  window: { start: string; end: string } | null
  paused: boolean
  lastSuccessAt: string | null
  overdueSince: string | null
  nextRunAt: string | null
}

export interface Violation {
  code: string
  message: string
  assignmentId?: string
}

export interface ProjectView {
  project: { id: string; name: string; createdAt: string; revision: number }
  assignments: Assignment[]
  policies: Policy[]
  topology: { valid: boolean; errors: Violation[]; warnings: Violation[] }
}

export interface Plan {
  id: string
  kind: 'assignments' | 'deletion' | 'repair'
  status: 'pending' | 'confirmed' | 'expired'
  preview: { summary: string; lines: string[]; movesData: boolean; deletesData: boolean; bytesToCopy: number; filesToDelete: number }
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'skipped'

export interface Job {
  id: string
  kind: 'backup' | 'verification' | 'inventory_scan' | 'deletion' | 'repair'
  status: JobStatus
  trigger: 'manual' | 'schedule' | 'catch_up'
  policyId: string | null
  projectId: string | null
  diskId: string | null
  dryRun: boolean
  progress: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number; phase?: 'scanning' | 'checking' | 'copying' | 'verifying' }
  result: Record<string, unknown> | null
  error: { code: string; message: string } | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequestedAt: string | null
}

export interface ReconstructedProject {
  id: string
  name: string
  revision: number
  assignments: { id: string; folder: string; role: Role; label: string; disk: { serial: string | null; model: string } }[]
}

export interface DomainEvent {
  seq: number
  id: string
  type: string
  occurredAt: string
  payload: Record<string, unknown>
}
