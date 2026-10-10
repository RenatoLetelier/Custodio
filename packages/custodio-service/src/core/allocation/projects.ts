import type { Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import { META_DIR } from '../shared/files.js'
import { assignmentRoot } from '../shared/layout.js'
import type { Assignment, Policy, Project } from '../shared/model.js'
import { validateTopology, type TopologyPolicy, type TopologyResult, type TopologySizes } from './topology.js'

export interface ProjectView {
  project: Project
  assignments: Assignment[]
  policies: Policy[]
  topology: TopologyResult
}

const skipMeta = (relPath: string): boolean => relPath === META_DIR || relPath.endsWith(`/${META_DIR}`)

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
    let total = 0
    for await (const entry of this.core.fs.walk(assignmentRoot(disk.mountPath, assignment), skipMeta)) total += entry.size
    return total
  }

  // Sizes for the capacity rule; folders on disconnected disks are left out
  async measure(assignments: Assignment[], policies: TopologyPolicy[]): Promise<TopologySizes> {
    const sourceBytes = new Map<string, number>()
    const destinationCapacity = new Map<string, number>()
    const byId = new Map(assignments.map((a) => [a.id, a]))
    const sources = new Set(policies.flatMap((p) => p.sources))
    const destinations = new Set(policies.flatMap((p) => p.destinations))

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
      destinationCapacity.set(id, usage.freeBytes + ((await this.folderBytes(assignment)) ?? 0))
    }
    return { sourceBytes, destinationCapacity }
  }
}
