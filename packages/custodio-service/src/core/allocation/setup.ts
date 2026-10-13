import { z } from 'zod'
import { validateSchedule } from '../backup/schedule.js'
import type { Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import { baseName } from '../shared/files.js'
import { assignmentRoot, displayFolder } from '../shared/layout.js'
import type { Assignment, Plan, Policy, PolicyConfig, Project } from '../shared/model.js'
import { normalizeRelative } from '../shared/paths.js'
import { PolicyConfigSchema, PolicyPatchSchema } from '../shared/policy.js'
import type { DescriptorService } from './descriptor.js'
import { assertFree, type PlanService } from './plans.js'
import type { ProjectService } from './projects.js'
import type { TopologyResult } from './topology.js'

// A whole project in one go: what to back up, where its copies go (same paths on each backup disk) and when
export const ProjectSetupSchema = z.object({
  projectId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  sources: z.array(z.object({ diskId: z.string().min(1), folder: z.string() })).min(1).max(20),
  destinations: z.array(z.string().min(1)).min(1).max(5),
  schedule: z.object({ cron: z.string().trim().min(1), timezone: z.string().trim().min(1) }),
  options: PolicyPatchSchema.omit({ name: true, sources: true, destinations: true, cron: true, timezone: true }).default({})
})

export type ProjectSetup = z.infer<typeof ProjectSetupSchema>

interface Draft {
  project: Project | null
  assignments: Assignment[]
  removed: Assignment[]
  policy: PolicyConfig
  policyId: string
  extraPolicies: Policy[]
  topology: TopologyResult
}

// "D:\lc\prod" typed or picked: the leading separators and the drive are not part of the folder
const cleanFolder = (folder: string): string => normalizeRelative(folder.trim().replace(/^[a-zA-Z]:/, '').replace(/^[\\/]+/, ''))

export class ProjectSetupService {
  constructor(
    private readonly core: Core,
    private readonly projects: ProjectService,
    private readonly plans: PlanService,
    private readonly descriptors: DescriptorService
  ) {
    plans.register('setup', (plan, actor) => this.apply(plan, actor))
    plans.register('removal', (plan, actor) => this.applyRemoval(plan, actor))
  }

  async propose(setup: ProjectSetup, actor: string): Promise<{ plan: Plan; topology: TopologyResult }> {
    const draft = await this.draft(setup)
    if (!draft.topology.valid) throw new DomainError('topology_invalid', 'Este proyecto no es válido.', draft.topology)
    const { store } = this.core
    const disk = (id: string) => store.disks.get(id)
    const sources = draft.assignments.filter((a) => a.role === 'storage')
    const lines: string[] = []
    for (const source of sources) {
      const copies = draft.assignments.filter((a) => a.mirrorOf === source.id).map((a) => displayFolder(disk(a.diskId), a.folder))
      lines.push(`Se respaldará ${displayFolder(disk(source.diskId), source.folder)} en ${copies.join(' y ')}.`)
    }
    for (const gone of draft.removed) {
      const verb = gone.role === 'storage' ? 'dejará de respaldar' : 'dejará de copiar en'
      lines.push(`Custodio ${verb} ${displayFolder(disk(gone.diskId), gone.folder)}: lo que ya está ahí se queda.`)
    }
    if (draft.policy.mode === 'mirror') lines.push('Modo espejo: lo que se borre del original también se borrará de las copias.')
    else if (draft.policy.mode === 'retention') lines.push(`Lo que se borre del original quedará ${draft.policy.retentionDays} días en la papelera de las copias.`)
    lines.push('Lo que ya esté en un disco de respaldo con el mismo contenido se reconoce sin copiarlo de nuevo.')
    lines.push('Ahora no se moverá ni se borrará ningún archivo.')
    const summary = setup.projectId ? `Cambios en "${setup.name}".` : `Nuevo proyecto "${setup.name}".`
    const preview = { summary, lines, movesData: false, deletesData: false, bytesToCopy: 0, filesToDelete: 0 }
    return { plan: this.plans.create('setup', setup.projectId ?? null, { setup }, preview, actor), topology: draft.topology }
  }

  private async draft(setup: ProjectSetup): Promise<Draft> {
    const { store, fs } = this.core
    const project = setup.projectId ? (store.projects.get(setup.projectId) ?? null) : null
    if (setup.projectId && !project) throw notFound('el proyecto', setup.projectId)
    const sameName = store.projects.findByName(setup.name)
    if (sameName && sameName.id !== project?.id) throw new DomainError('conflict', `Ya existe un proyecto llamado "${setup.name}".`)
    const projectId = project?.id ?? null
    const current = projectId ? store.assignments.byProject(projectId) : []
    const now = this.core.clock.now().toISOString()
    const assignments: Assignment[] = []
    const label = (wanted: string) => {
      let text = wanted.trim() || 'Carpeta'
      for (let n = 2; assignments.some((a) => a.label.toLowerCase() === text.toLowerCase()); n++) text = `${wanted} ${n}`
      return text
    }

    for (const wanted of setup.sources) {
      const disk = store.disks.get(wanted.diskId)
      if (!disk) throw notFound('el disco', wanted.diskId)
      const folder = cleanFolder(wanted.folder)
      if (!disk.connected || !disk.mountPath) throw new DomainError('validation_failed', `El disco ${disk.model} no está conectado: conéctalo para elegir sus carpetas.`)
      const info = await fs.stat(assignmentRoot(disk.mountPath, { folder }))
      if (!info?.isDirectory) throw new DomainError('validation_failed', `La carpeta ${displayFolder(disk, folder)} no existe.`)
      if (assignments.some((a) => a.diskId === disk.id && a.folder === folder)) throw new DomainError('validation_failed', `${displayFolder(disk, folder)} está dos veces.`)
      assertFree(this.core, disk.id, folder, projectId)
      const kept = current.find((a) => a.role === 'storage' && a.diskId === disk.id && a.folder === folder)
      assignments.push(kept ?? { id: this.core.newId(), projectId: projectId ?? '', diskId: disk.id, folder, role: 'storage', label: label(baseName(folder) || disk.model), createdAt: now, mirrorOf: null })
    }

    const sources = [...assignments]
    for (const diskId of [...new Set(setup.destinations)]) {
      const disk = store.disks.get(diskId)
      if (!disk) throw notFound('el disco', diskId)
      for (const source of sources) {
        // A copy on its own disk is reported by the topology check, with the rest of what is wrong
        if (source.diskId !== diskId) assertFree(this.core, diskId, source.folder, projectId)
        const kept = current.find((a) => a.role === 'backup' && a.diskId === diskId && a.folder === source.folder && a.mirrorOf === source.id)
        assignments.push(kept ?? { id: this.core.newId(), projectId: projectId ?? '', diskId, folder: source.folder, role: 'backup', label: label(source.label), createdAt: now, mirrorOf: source.id })
      }
    }

    const existing = projectId ? store.policies.byProject(projectId) : []
    const [policyBefore, ...extraPolicies] = existing
    const { id: _id, projectId: _p, createdAt: _c, lastScheduledFor: _l, lastSuccessAt: _s, lastVerifiedAt: _v, overdueSince: _o, ...previous } = policyBefore ?? ({} as Partial<Policy>)
    const policy = PolicyConfigSchema.parse({
      ...previous,
      ...setup.options,
      name: setup.name,
      sources: sources.map((a) => a.id),
      destinations: assignments.filter((a) => a.role === 'backup').map((a) => a.id),
      cron: setup.schedule.cron,
      timezone: setup.schedule.timezone
    })
    validateSchedule(policy.cron, policy.timezone)
    if (policy.mode === 'mirror' && !policy.mirrorConfirmed) {
      throw new DomainError('mirror_not_allowed', 'El modo espejo borra en la copia lo que ya no está en el original: actívalo con la confirmación explícita.')
    }
    const policyId = policyBefore?.id ?? this.core.newId()
    const policies = [{ id: policyId, name: policy.name, sources: policy.sources, destinations: policy.destinations }]
    const topology = this.projects.structural(assignments, policies, await this.projects.measure(assignments, policies))
    const removed = current.filter((a) => !assignments.some((n) => n.id === a.id))
    return { project, assignments, removed, policy, policyId, extraPolicies, topology }
  }

  private async apply(plan: Plan, actor: string): Promise<Record<string, unknown>> {
    const setup = ProjectSetupSchema.parse(plan.payload.setup)
    const draft = await this.draft(setup)
    if (!draft.topology.valid) throw new DomainError('topology_invalid', 'El proyecto cambió desde que se revisó.', draft.topology)
    const { store, clock } = this.core
    const now = clock.now().toISOString()
    const projectId = draft.project?.id ?? this.core.newId()

    store.transaction(() => {
      if (draft.project) store.projects.update({ ...draft.project, name: setup.name, revision: draft.project.revision + 1 })
      else store.projects.insert({ id: projectId, name: setup.name, createdAt: now, revision: 1 })
      for (const policy of draft.extraPolicies) store.policies.remove(policy.id)
      for (const assignment of draft.removed) store.assignments.remove(assignment.id)
      for (const assignment of draft.assignments) {
        const row = { ...assignment, projectId }
        if (store.assignments.get(row.id)) store.assignments.update(row)
        else store.assignments.insert(row)
      }
      const before = store.policies.get(draft.policyId)
      if (before) {
        const scheduleChanged = before.cron !== draft.policy.cron || before.timezone !== draft.policy.timezone
        // A new schedule starts counting from now, so it does not trigger a catch-up of slots it never had
        store.policies.update({ ...before, ...draft.policy, lastScheduledFor: scheduleChanged ? now : before.lastScheduledFor })
      } else {
        store.policies.insert({ ...draft.policy, id: draft.policyId, projectId, createdAt: now, lastScheduledFor: null, lastSuccessAt: null, lastVerifiedAt: null, overdueSince: null })
      }
      this.core.audit.record({ actor, action: 'project.setup', target: projectId, details: { planId: plan.id, setup } })
    })

    for (const assignment of draft.removed) {
      const disk = store.disks.get(assignment.diskId)
      if (disk?.connected && disk.mountPath) await this.descriptors.forget(disk.mountPath, assignment)
    }
    await this.descriptors.writeProject(projectId)
    return { projectId }
  }

  // Custodio stops backing the project up; originals and copies stay exactly where they are
  proposeRemoval(projectId: string, actor: string): Plan {
    const { store } = this.core
    const project = this.projects.get(projectId)
    const policies = store.policies.byProject(projectId)
    if (policies.some((p) => store.locks.holder(p.id))) throw new DomainError('conflict', 'Hay una copia en curso de este proyecto: espera a que termine.')
    if (store.deletions.byProject(projectId).some((o) => o.status === 'pending')) {
      throw new DomainError('conflict', 'Este proyecto tiene un borrado de copias pendiente: termina cuando sus discos estén conectados.')
    }
    const lines = store.assignments
      .byProject(projectId)
      .filter((a) => a.role === 'storage')
      .map((a) => `Custodio dejará de respaldar ${displayFolder(store.disks.get(a.diskId), a.folder)}.`)
    lines.push('No se borra ningún archivo: los originales y las copias se quedan donde están.')
    const preview = { summary: `Se eliminará el proyecto "${project.name}".`, lines, movesData: false, deletesData: false, bytesToCopy: 0, filesToDelete: 0 }
    return this.plans.create('removal', projectId, {}, preview, actor)
  }

  private async applyRemoval(plan: Plan, actor: string): Promise<Record<string, unknown>> {
    const projectId = plan.projectId as string
    const { store } = this.core
    const project = this.projects.get(projectId)
    const assignments = store.assignments.byProject(projectId)
    store.transaction(() => {
      for (const policy of store.policies.byProject(projectId)) store.policies.remove(policy.id)
      for (const assignment of assignments) store.assignments.remove(assignment.id)
      store.projects.remove(projectId)
      this.core.audit.record({ actor, action: 'project.removed', target: projectId, details: { planId: plan.id, name: project.name } })
    })
    for (const assignment of assignments) {
      const disk = store.disks.get(assignment.diskId)
      if (disk?.connected && disk.mountPath) await this.descriptors.forget(disk.mountPath, assignment)
    }
    return { projectId }
  }
}
