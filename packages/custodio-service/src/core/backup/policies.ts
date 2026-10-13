import type { DescriptorService } from '../allocation/descriptor.js'
import type { ProjectService } from '../allocation/projects.js'
import type { Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import type { Policy, PolicyConfig } from '../shared/model.js'
import { PolicyConfigSchema, type PolicyConfigInput, type PolicyPatch } from '../shared/policy.js'
import { validateSchedule } from './schedule.js'

export class PolicyService {
  constructor(
    private readonly core: Core,
    private readonly projects: ProjectService,
    private readonly descriptors: DescriptorService
  ) {}

  get(policyId: string): Policy {
    const policy = this.core.store.policies.get(policyId)
    if (!policy) throw notFound('la copia programada', policyId)
    return policy
  }

  // Folders are measured only when what is copied, or where, changes: pausing or a new schedule stay instant
  private async validate(projectId: string, config: PolicyConfig, policyId: string, measure: boolean): Promise<void> {
    validateSchedule(config.cron, config.timezone)
    if (config.mode === 'mirror' && !config.mirrorConfirmed) {
      throw new DomainError('mirror_not_allowed', 'El modo espejo borra en la copia lo que ya no está en el original: actívalo con la confirmación explícita.')
    }
    const assignments = this.core.store.assignments.byProject(projectId)
    for (const id of [...config.sources, ...config.destinations]) {
      if (!assignments.some((a) => a.id === id)) throw new DomainError('validation_failed', `La carpeta ${id} no pertenece a este proyecto.`)
    }
    const others = this.core.store.policies.byProject(projectId).filter((p) => p.id !== policyId)
    const policies = [...others, { id: policyId, name: config.name, sources: config.sources, destinations: config.destinations }]
    const topology = this.projects.structural(assignments, policies, measure ? await this.projects.measure(assignments, policies) : undefined)
    if (!topology.valid) throw new DomainError('topology_invalid', 'Esta copia programada no es válida.', topology)
  }

  async create(projectId: string, input: PolicyConfigInput, actor: string): Promise<Policy> {
    this.projects.get(projectId)
    const config = PolicyConfigSchema.parse(input)
    const id = this.core.newId()
    await this.validate(projectId, config, id, true)
    const policy: Policy = {
      ...config,
      id,
      projectId,
      createdAt: this.core.clock.now().toISOString(),
      lastScheduledFor: null,
      lastSuccessAt: null,
      lastVerifiedAt: null,
      overdueSince: null
    }
    this.commit(projectId, () => this.core.store.policies.insert(policy), actor, 'policy.created', policy.id, { config })
    await this.descriptors.writeProject(projectId)
    return policy
  }

  async update(policyId: string, patch: PolicyPatch, actor: string): Promise<Policy> {
    const current = this.get(policyId)
    const { id, projectId, createdAt, lastScheduledFor, lastSuccessAt, lastVerifiedAt, overdueSince, ...config } = current
    const next = PolicyConfigSchema.parse({ ...config, ...patch })
    const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((value) => b.includes(value))
    await this.validate(projectId, next, id, !sameIds(next.sources, current.sources) || !sameIds(next.destinations, current.destinations))
    const scheduleChanged = next.cron !== current.cron || next.timezone !== current.timezone
    const updated: Policy = {
      ...next,
      id,
      projectId,
      createdAt,
      // A new schedule starts counting from now, so it does not trigger a catch-up of slots it never had
      lastScheduledFor: scheduleChanged ? this.core.clock.now().toISOString() : lastScheduledFor,
      lastSuccessAt,
      lastVerifiedAt,
      overdueSince
    }
    this.commit(projectId, () => this.core.store.policies.update(updated), actor, 'policy.updated', id, { patch })
    await this.descriptors.writeProject(projectId)
    return updated
  }

  private commit(projectId: string, change: () => void, actor: string, action: string, target: string, details: Record<string, unknown>): void {
    const { store, audit } = this.core
    store.transaction(() => {
      change()
      const project = this.projects.get(projectId)
      store.projects.update({ ...project, revision: project.revision + 1 })
      audit.record({ actor, action, target, details })
    })
  }
}
