import { z } from 'zod'
import type { Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import { baseName } from '../shared/files.js'
import type { Assignment, Plan, PlanKind, PlanPreview, Role } from '../shared/model.js'
import { normalizeRelative } from '../shared/paths.js'
import { RoleSchema } from '../shared/policy.js'
import type { DescriptorService } from './descriptor.js'
import type { ProjectService } from './projects.js'
import type { TopologyResult } from './topology.js'

export const AssignmentActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_assignment'),
    diskId: z.string().min(1),
    folder: z.string(),
    role: RoleSchema,
    label: z.string().trim().min(1).max(80).optional()
  }),
  z.object({ type: z.literal('change_role'), assignmentId: z.string().min(1), role: RoleSchema }),
  z.object({ type: z.literal('remove_assignment'), assignmentId: z.string().min(1) })
])

export type AssignmentAction = z.infer<typeof AssignmentActionSchema>
export type PlanHandler = (plan: Plan, actor: string) => Promise<Record<string, unknown>>

export const PLAN_TTL_MS = 30 * 60 * 1000

const ROLE_TEXT: Record<Role, string> = { storage: 'guardar archivos', backup: 'recibir copias de seguridad' }

export class PlanService {
  private readonly handlers = new Map<PlanKind, PlanHandler>()

  constructor(
    private readonly core: Core,
    private readonly projects: ProjectService,
    private readonly descriptors: DescriptorService
  ) {
    this.handlers.set('assignments', (plan, actor) => this.applyAssignments(plan, actor))
  }

  register(kind: PlanKind, handler: PlanHandler): void {
    this.handlers.set(kind, handler)
  }

  get(planId: string): Plan {
    const plan = this.core.store.plans.get(planId)
    if (!plan) throw notFound('el plan', planId)
    return plan
  }

  create(kind: PlanKind, projectId: string | null, payload: Record<string, unknown>, preview: PlanPreview, actor: string): Plan {
    const now = this.core.clock.now()
    const plan: Plan = {
      id: this.core.newId(),
      kind,
      projectId,
      status: 'pending',
      payload,
      preview,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
      decidedAt: null,
      decidedBy: null,
      createdBy: actor
    }
    this.core.store.plans.insert(plan)
    return plan
  }

  // Role changes and new disks never move data: they only produce a plan that waits for explicit confirmation
  proposeAssignments(projectId: string, actions: AssignmentAction[], actor: string): { plan: Plan; topology: TopologyResult } {
    const project = this.projects.get(projectId)
    if (actions.length === 0) throw new DomainError('validation_failed', 'El plan no tiene cambios.')
    const { next, lines } = this.simulate(projectId, actions)
    const topology = this.projects.structural(next, this.core.store.policies.byProject(projectId))
    if (!topology.valid) throw new DomainError('topology_invalid', 'Este cambio deja las copias en un estado no válido.', topology)

    const preview: PlanPreview = {
      summary: `Cambios en "${project.name}". No se moverá ni se borrará ningún archivo.`,
      lines: [...lines, 'No se moverá ni se borrará ningún archivo: los datos se quedan donde están.'],
      movesData: false,
      deletesData: false,
      bytesToCopy: 0,
      filesToDelete: 0
    }
    return { plan: this.create('assignments', projectId, { actions }, preview, actor), topology }
  }

  async confirm(planId: string, actor: string, confirm: unknown): Promise<{ plan: Plan; result: Record<string, unknown> }> {
    if (confirm !== true) throw new DomainError('confirmation_required', 'Para aplicar el plan hay que confirmarlo de forma explícita.')
    const { store, clock } = this.core
    const pending = this.get(planId)
    if (pending.status === 'pending' && Date.parse(pending.expiresAt) <= clock.now().getTime()) {
      store.plans.update({ ...pending, status: 'expired' })
      throw new DomainError('plan_not_pending', 'El plan venció. Vuelve a revisarlo antes de confirmar.')
    }
    const plan = store.transaction(() => {
      const current = this.get(planId)
      if (current.status !== 'pending') throw new DomainError('plan_not_pending', 'Este plan ya fue confirmado o venció.')
      const confirmed: Plan = { ...current, status: 'confirmed', decidedAt: clock.now().toISOString(), decidedBy: actor }
      store.plans.update(confirmed)
      return confirmed
    })

    const handler = this.handlers.get(plan.kind)
    if (!handler) throw new Error(`No handler for plan kind ${plan.kind}`)
    try {
      const result = await handler(plan, actor)
      this.core.audit.record({ actor, action: 'plan.confirmed', target: plan.id, details: { kind: plan.kind, projectId: plan.projectId } })
      return { plan, result }
    } catch (error) {
      store.plans.update({ ...plan, status: 'pending', decidedAt: null, decidedBy: null })
      throw error
    }
  }

  private simulate(projectId: string, actions: AssignmentAction[]): { next: Assignment[]; lines: string[] } {
    const { store, clock } = this.core
    let next = store.assignments.byProject(projectId).map((a) => ({ ...a }))
    const lines: string[] = []
    const now = clock.now().toISOString()

    for (const action of actions) {
      if (action.type === 'add_assignment') {
        const disk = store.disks.get(action.diskId)
        if (!disk) throw notFound('el disco', action.diskId)
        const folder = normalizeRelative(action.folder)
        const taken = [...store.assignments.byDisk(disk.id).filter((a) => a.projectId !== projectId), ...next.filter((a) => a.diskId === disk.id)]
        if (taken.some((a) => a.folder === folder)) throw new DomainError('conflict', `La carpeta "${folder || '(raíz)'}" de ese disco ya está asignada.`)
        const label = this.uniqueLabel(action.label ?? (baseName(folder) || disk.model), next)
        next.push({ id: this.core.newId(), projectId, diskId: disk.id, folder, role: action.role, label, createdAt: now })
        lines.push(`Se usará la carpeta "${folder || '(raíz)'}" del disco ${disk.model} para ${ROLE_TEXT[action.role]}.`)
      } else {
        const target = next.find((a) => a.id === action.assignmentId)
        if (!target) throw notFound('la carpeta asignada', action.assignmentId)
        if (action.type === 'change_role') {
          target.role = action.role
          lines.push(`"${target.label}" pasará a ${ROLE_TEXT[action.role]}.`)
        } else {
          const usedBy = store.policies.byProject(projectId).find((p) => p.sources.includes(target.id) || p.destinations.includes(target.id))
          if (usedBy) throw new DomainError('conflict', `Primero quita "${target.label}" de la copia "${usedBy.name}".`)
          next = next.filter((a) => a.id !== target.id)
          lines.push(`Custodio dejará de usar "${target.label}". Sus archivos se quedan en el disco.`)
        }
      }
    }
    return { next, lines }
  }

  private uniqueLabel(wanted: string, existing: Assignment[]): string {
    const taken = new Set(existing.map((a) => a.label.toLowerCase()))
    let label = wanted.trim() || 'Carpeta'
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${wanted} ${n}`
    return label
  }

  private async applyAssignments(plan: Plan, actor: string): Promise<Record<string, unknown>> {
    const projectId = plan.projectId as string
    const actions = z.array(AssignmentActionSchema).parse(plan.payload.actions)
    const { store } = this.core
    const before = store.assignments.byProject(projectId)
    const { next } = this.simulate(projectId, actions)
    const topology = this.projects.structural(next, store.policies.byProject(projectId))
    if (!topology.valid) throw new DomainError('topology_invalid', 'El proyecto cambió desde que se generó el plan.', topology)

    const removed = before.filter((a) => !next.some((n) => n.id === a.id))
    store.transaction(() => {
      for (const assignment of removed) store.assignments.remove(assignment.id)
      for (const assignment of next) {
        if (before.some((b) => b.id === assignment.id)) store.assignments.update(assignment)
        else store.assignments.insert(assignment)
      }
      const project = this.projects.get(projectId)
      store.projects.update({ ...project, revision: project.revision + 1 })
      this.core.audit.record({ actor, action: 'assignments.changed', target: projectId, details: { planId: plan.id, actions } })
    })

    for (const assignment of removed) {
      const disk = store.disks.get(assignment.diskId)
      if (disk?.connected && disk.mountPath) await this.descriptors.forget(disk.mountPath, assignment)
    }
    await this.descriptors.writeProject(projectId)
    return { assignments: store.assignments.byProject(projectId) }
  }
}
