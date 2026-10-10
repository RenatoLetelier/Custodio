import { nextRun } from './backup/schedule.js'
import type { Core } from './shared/context.js'
import type { Health, Job } from './shared/model.js'

export interface Overview {
  status: Health
  reasons: string[]
  disks: { total: number; connected: number; unassigned: number }
  space: { totalBytes: number; freeBytes: number }
  lastBackup: Pick<Job, 'id' | 'policyId' | 'status' | 'finishedAt'> | null
  nextBackup: { policyId: string; at: string } | null
}

const RANK: Record<Health, number> = { green: 0, unknown: 1, yellow: 2, red: 3 }

// One look at everything: worst disk, overdue or failed copies, space and the next scheduled run
export function buildOverview(core: Core): Overview {
  const { store, clock } = core
  const disks = store.disks.list()
  const assignedDisks = new Set(store.assignments.list().map((a) => a.diskId))
  const policies = store.policies.list()
  const reasons: string[] = []
  let status: Health = 'green'
  const raise = (level: Health, reason: string): void => {
    reasons.push(reason)
    if (RANK[level] > RANK[status]) status = level
  }

  for (const disk of disks.filter((d) => assignedDisks.has(d.id))) {
    if (disk.health === 'red') raise('red', 'disk_failing')
    else if (disk.health === 'yellow') raise('yellow', 'disk_attention')
    else if (disk.health === 'unknown') raise('yellow', 'disk_health_unknown')
    if (!disk.connected) raise('yellow', 'disk_disconnected')
    if (disk.capacityLow) raise('yellow', 'capacity_low')
  }
  for (const policy of policies) {
    if (policy.overdueSince) raise('red', 'backup_overdue')
    const last = store.jobs.list({ policyId: policy.id, kind: 'backup', status: ['succeeded', 'failed'], limit: 5 }).find((j) => !j.dryRun)
    if (last?.status === 'failed') raise('red', 'backup_failed')
  }
  if (assignedDisks.size === 0) raise('unknown', 'not_configured')

  let totalBytes = 0
  let freeBytes = 0
  for (const disk of disks.filter((d) => d.connected && assignedDisks.has(d.id))) {
    const reading = store.disks.readings(disk.id, '').at(-1)
    if (!reading) continue
    totalBytes += reading.totalBytes
    freeBytes += reading.totalBytes - reading.usedBytes
  }

  const lastJob = store.jobs.list({ kind: 'backup', status: ['succeeded', 'failed'], limit: 20 }).find((j) => !j.dryRun) ?? null
  const now = clock.now()
  let nextBackup: Overview['nextBackup'] = null
  for (const policy of policies.filter((p) => !p.paused)) {
    const at = nextRun(policy.cron, policy.timezone, now)
    if (at && (!nextBackup || at.getTime() < Date.parse(nextBackup.at))) nextBackup = { policyId: policy.id, at: at.toISOString() }
  }

  return {
    status,
    reasons: [...new Set(reasons)],
    disks: { total: disks.length, connected: disks.filter((d) => d.connected).length, unassigned: disks.filter((d) => !assignedDisks.has(d.id)).length },
    space: { totalBytes, freeBytes },
    lastBackup: lastJob && { id: lastJob.id, policyId: lastJob.policyId, status: lastJob.status, finishedAt: lastJob.finishedAt },
    nextBackup
  }
}
