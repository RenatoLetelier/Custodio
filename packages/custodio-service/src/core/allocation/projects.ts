import type { Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import { isSkippedDir } from '../shared/files.js'
import { assignmentRoot } from '../shared/layout.js'
import type { Assignment, Policy, Project } from '../shared/model.js'
import { validateTopology, type TopologyPolicy, type TopologyResult, type TopologySizes } from './topology.js'

export interface ProjectView {
  project: Project
  assignments: Assignment[]
  policies: Policy[]
  topology: TopologyResult
}


export class ProjectService {
  constructor(private readonly core: Core) {}

  create(name: string, actor: string): Project {
    const { store, clock, audit } = this.core
    const trimmed = name.trim()
    if (trimmed === '') throw new DomainError('validation_failed', 'El proyecto necesita un nombre.')
    return store.transaction(() => {
      if (store.projects.findByName(trimmed)) throw new DomainError('conflict', `Ya existe un proyecto llamado "${trimmed}".`)
      const project: Project = { id: this.core.newId(), name: trimmed, createdAt: clock.now().toISOString(), revision: 1 }
      store.projects.insert(project)
      audit.record({ actor, action: 'project.created', target: project.id, details: { name: trimmed } })
      return project
    })
  }

  get(projectId: string): Project {
    const project = this.core.store.projects.get(projectId)
    if (!project) throw notFound('el proyecto', projectId)
    return project
  }

  view(projectId: string): ProjectView {
    const project = this.get(projectId)
    const assignments = this.core.store.assignments.byProject(projectId)
    const policies = this.core.store.policies.byProject(projectId)
    return { project, assignments, policies, topology: this.structural(assignments, policies) }
  }

  structural(assignments: Assignment[], policies: TopologyPolicy[], sizes?: TopologySizes): TopologyResult {
    return validateTopology({ assignments, policies, disks: this.core.store.disks.list(), sizes })
  }

  async topology(projectId: string, extraPolicy?: TopologyPolicy): Promise<TopologyResult> {
    const assignments = this.core.store.assignments.byProject(projectId)
    const policies: TopologyPolicy[] = [...this.core.store.policies.byProject(projectId), ...(extraPolicy ? [extraPolicy] : [])]
    return this.structural(assignments, policies, await this.measure(assignments, policies))
  }

  async folderBytes(assignment: Assignment): Promise<number | null> {
    const disk = this.core.store.disks.get(assignment.diskId)
    if (!disk?.connected || !disk.mountPath) return null
    // An estimate for the capacity rule: what this account cannot read is left out, the backup reports it
    return this.core.fs.sizeOf(assignmentRoot(disk.mountPath, assignment), isSkippedDir)
  }

  // Sizes for the capacity rule; folders on disconnected disks are left out.
  // Measuring big folders takes minutes, so it is skipped when the disks' free space already settles it.
  async measure(assignments: Assignment[], policies: TopologyPolicy[]): Promise<TopologySizes | undefined> {
    const sourceBytes = new Map<string, number>()
    const destinationCapacity = new Map<string, number>()
    const destinationUsed = new Map<string, number>()
    const byId = new Map(assignments.map((a) => [a.id, a]))
    const sources = new Set(policies.flatMap((p) => p.sources))
    const destinations = new Set(policies.flatMap((p) => p.destinations))
    const diskIds = (ids: Set<string>) => new Set([...ids].map((id) => byId.get(id)?.diskId).filter((id): id is string => id !== undefined))
    if (await this.surelyFits(diskIds(sources), diskIds(destinations))) return undefined

    for (const id of sources) {
      const assignment = byId.get(id)
      const bytes = assignment ? await this.folderBytes(assignment) : null
      if (bytes !== null) sourceBytes.set(id, bytes)
    }
    for (const id of destinations) {
      const assignment = byId.get(id)
      const disk = assignment ? this.core.store.disks.get(assignment.diskId) : null
      if (!assignment || !disk?.connected || !disk.mountPath) continue
      const usage = await this.core.volumes.usage(disk.mountPath)
      if (!usage) continue
      const inFolder = (await this.folderBytes(assignment)) ?? 0
      destinationUsed.set(id, inFolder)
      destinationCapacity.set(id, usage.freeBytes + inFolder)
    }
    return { sourceBytes, destinationCapacity, destinationUsed }
  }

  // Every destination disk has more free space than all the source disks have in use
  private async surelyFits(sourceDisks: Set<string>, destinationDisks: Set<string>): Promise<boolean> {
    const usage = async (diskId: string) => {
      const disk = this.core.store.disks.get(diskId)
      return disk?.connected && disk.mountPath ? this.core.volumes.usage(disk.mountPath) : null
    }
    let inUse = 0
    for (const diskId of sourceDisks) {
      const found = await usage(diskId)
      if (!found) return false
      inUse += found.totalBytes - found.freeBytes
    }
    for (const diskId of destinationDisks) {
      const found = await usage(diskId)
      if (!found || found.freeBytes < inUse) return false
    }
    return true
  }
}
