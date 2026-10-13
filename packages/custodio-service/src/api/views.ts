import type { ProjectView } from '../core/allocation/projects.js'
import type { TopologyResult, Violation } from '../core/allocation/topology.js'
import { summarizeCapacity, trendSince } from '../core/inventory-health/capacity.js'
import { nextRun } from '../core/backup/schedule.js'
import type { Core } from '../core/shared/context.js'
import type { Disk, Policy } from '../core/shared/model.js'

// Domain → API shapes, field by field, so responses carry exactly what openapi.yaml promises

export function diskView(core: Core, disk: Disk) {
  const assignments = core.store.assignments.byDisk(disk.id)
  return {
    id: disk.id,
    serial: disk.serial,
    wwn: disk.wwn,
    model: disk.model,
    sizeBytes: disk.sizeBytes,
    bus: disk.bus,
    devicePath: disk.devicePath,
    mountPath: disk.mountPath,
    connected: disk.connected,
    state: assignments.length > 0 ? ('assigned' as const) : ('unassigned' as const),
    health: disk.health,
    healthReasons: disk.healthReasons,
    advisories: disk.advisories,
    smart: disk.smart,
    capacity: summarizeCapacity(core.store.disks.readings(disk.id, trendSince(core.clock.now()))),
    capacityLow: disk.capacityLow,
    assignments: assignments.map((a) => ({ assignmentId: a.id, projectId: a.projectId, folder: a.folder, role: a.role, label: a.label })),
    firstSeenAt: disk.firstSeenAt,
    lastSeenAt: disk.lastSeenAt
  }
}

export function policyView(core: Core, policy: Policy) {
  const next = policy.paused ? null : nextRun(policy.cron, policy.timezone, core.clock.now())
  return { ...policy, nextRunAt: next ? next.toISOString() : null }
}

const violation = (v: Violation) => ({
  code: v.code,
  message: v.message,
  ...(v.policyId ? { policyId: v.policyId } : {}),
  ...(v.assignmentId ? { assignmentId: v.assignmentId } : {})
})

export const topologyView = (t: TopologyResult) => ({ valid: t.valid, errors: t.errors.map(violation), warnings: t.warnings.map(violation) })

export function projectView(core: Core, view: ProjectView) {
  return {
    project: view.project,
    assignments: view.assignments.map((a) => ({ ...a, mirrorOf: a.mirrorOf ?? null })),
    policies: view.policies.map((p) => policyView(core, p)),
    topology: topologyView(view.topology)
  }
}
