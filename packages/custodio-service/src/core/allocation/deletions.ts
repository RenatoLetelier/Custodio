import { z } from 'zod'
import { SYSTEM_ACTOR, type Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import { assignmentRoot, copyRoot } from '../shared/layout.js'
import type { Assignment, DeletionItem, DeletionOrder, Plan } from '../shared/model.js'
import { normalizeRelative, resolveInside } from '../shared/paths.js'
import type { PlanService } from './plans.js'

export const DeletionRequestSchema = z.object({
  items: z.array(z.object({ sourceId: z.string().min(1), path: z.string().min(1) })).min(1).max(1000),
  destinations: z.array(z.string().min(1)).min(1).optional()
})

export type DeletionRequest = z.infer<typeof DeletionRequestSchema>

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// Custodio never deletes at the source: an order only removes copies, and waits for disks that are away
export class DeletionService {
  constructor(
    private readonly core: Core,
    private readonly plans: PlanService
  ) {
    plans.register('deletion', (plan, actor) => this.apply(plan, actor))
  }

  get(orderId: string): DeletionOrder {
    const order = this.core.store.deletions.get(orderId)
    if (!order) throw notFound('la orden de borrado', orderId)
    return order
  }

  preview(projectId: string, request: DeletionRequest, actor: string): Plan {
    const { store } = this.core
    const project = store.projects.get(projectId)
    if (!project) throw notFound('el proyecto', projectId)
    const assignments = store.assignments.byProject(projectId)
    const items: DeletionItem[] = request.items.map((item) => {
      const source = assignments.find((a) => a.id === item.sourceId)
      if (!source) throw notFound('la carpeta de origen', item.sourceId)
      if (source.role !== 'storage') throw new DomainError('validation_failed', `"${source.label}" no es una carpeta de origen.`)
      const path = normalizeRelative(item.path)
      if (path === '') throw new DomainError('invalid_path', 'Indica qué archivo o carpeta borrar de las copias.')
      return { sourceId: source.id, path }
    })

    const destinations = this.destinationsFor(projectId, assignments, items, request.destinations)
    const away = destinations.filter((d) => !store.disks.get(d.diskId)?.connected)
    const lines = [
      `Se borrará${items.length === 1 ? '' : 'n'} ${count(items.length, 'elemento', 'elementos')} de ${count(destinations.length, 'copia de seguridad', 'copias de seguridad')}: ${destinations.map((d) => `"${d.label}"`).join(', ')}.`,
      'Los archivos originales no se tocan.'
    ]
    for (const destination of away) lines.push(`"${destination.label}" está desconectado: se borrará cuando lo vuelvas a conectar.`)

    return this.plans.create(
      'deletion',
      projectId,
      { items, destinations: destinations.map((d) => d.id) },
      {
        summary: `Borrar ${count(items.length, 'elemento', 'elementos')} de las copias de "${project.name}". El original no se toca.`,
        lines,
        movesData: false,
        deletesData: true,
        bytesToCopy: 0,
        filesToDelete: items.length * destinations.length
      },
      actor
    )
  }

  private destinationsFor(projectId: string, assignments: Assignment[], items: DeletionItem[], requested?: string[]): Assignment[] {
    if (requested) {
      return requested.map((id) => {
        const destination = assignments.find((a) => a.id === id)
        if (!destination) throw notFound('la copia', id)
        if (destination.role !== 'backup') throw new DomainError('source_protected', `"${destination.label}" guarda originales: Custodio nunca borra en el origen.`)
        return destination
      })
    }
    const sources = new Set(items.map((i) => i.sourceId))
    const ids = new Set(
      this.core.store.policies
        .byProject(projectId)
        .filter((p) => p.sources.some((s) => sources.has(s)))
        .flatMap((p) => p.destinations)
    )
    const destinations = assignments.filter((a) => ids.has(a.id) && a.role === 'backup')
    if (destinations.length === 0) throw new DomainError('unprocessable', 'Esos archivos no tienen copias de seguridad que borrar.')
    return destinations
  }

  private async apply(plan: Plan, actor: string): Promise<Record<string, unknown>> {
    const { store, clock } = this.core
    const payload = z.object({ items: z.array(z.object({ sourceId: z.string(), path: z.string() })), destinations: z.array(z.string()) }).parse(plan.payload)
    const order: DeletionOrder = {
      id: this.core.newId(),
      projectId: plan.projectId as string,
      items: payload.items,
      createdAt: clock.now().toISOString(),
      requestedBy: actor,
      status: 'pending',
      targets: payload.destinations.map((destinationId) => ({ orderId: '', destinationId, status: 'pending', attempts: 0, lastError: null, doneAt: null }))
    }
    order.targets = order.targets.map((t) => ({ ...t, orderId: order.id }))
    store.transaction(() => {
      store.deletions.insert(order)
      this.core.audit.record({ actor, action: 'deletion.ordered', target: order.id, details: { projectId: order.projectId, items: order.items, destinations: payload.destinations } })
    })
    return { order: await this.process(order.id) }
  }

  async process(orderId: string): Promise<DeletionOrder> {
    const { store, clock, fs } = this.core
    const order = this.get(orderId)
    for (const target of order.targets.filter((t) => t.status === 'pending')) {
      const destination = store.assignments.get(target.destinationId)
      const disk = destination ? store.disks.get(destination.diskId) : null
      if (!destination || destination.role !== 'backup') {
        store.deletions.updateTarget({ ...target, attempts: target.attempts + 1, lastError: 'not_a_backup' })
        continue
      }
      if (!disk?.connected || !disk.mountPath) {
        store.deletions.updateTarget({ ...target, attempts: target.attempts + 1, lastError: 'disk_disconnected' })
        continue
      }
      try {
        const root = assignmentRoot(disk.mountPath, destination)
        const removed: string[] = []
        for (const item of order.items) {
          const source = store.assignments.get(item.sourceId)
          if (!source) continue
          const path = resolveInside(copyRoot(root, source), item.path)
          const info = await fs.stat(path)
          if (info?.isFile) await fs.removeFile(path)
          else if (info?.isDirectory) await fs.removeTree(path)
          for (const entry of store.manifest.list(destination.id, source.id)) {
            if (entry.relPath === item.path || entry.relPath.startsWith(`${item.path}/`)) store.manifest.remove(destination.id, source.id, entry.relPath)
          }
          removed.push(item.path)
        }
        store.transaction(() => {
          store.deletions.updateTarget({ ...target, status: 'done', attempts: target.attempts + 1, lastError: null, doneAt: clock.now().toISOString() })
          this.core.audit.record({ actor: SYSTEM_ACTOR, action: 'deletion.applied', target: order.id, details: { destinationId: destination.id, diskId: disk.id, removed, requestedBy: order.requestedBy } })
        })
      } catch (error) {
        store.deletions.updateTarget({ ...target, attempts: target.attempts + 1, lastError: error instanceof Error ? error.message : String(error) })
      }
    }
    const updated = this.get(orderId)
    if (updated.status === 'pending' && updated.targets.every((t) => t.status === 'done')) {
      store.deletions.setStatus(orderId, 'completed')
      return this.get(orderId)
    }
    return updated
  }

  async retryPending(): Promise<string[]> {
    const orders = new Set(this.core.store.deletions.pendingTargets().map((t) => t.orderId))
    const completed: string[] = []
    for (const orderId of orders) {
      if ((await this.process(orderId)).status === 'completed') completed.push(orderId)
    }
    return completed
  }

  // Paths the project asked to drop from its copies; the engine will not bring them back unless they change
  tombstones(projectId: string): Map<string, number> {
    const map = new Map<string, number>()
    for (const order of this.core.store.deletions.byProject(projectId)) {
      for (const item of order.items) map.set(`${item.sourceId}\u0000${item.path}`, Date.parse(order.createdAt))
    }
    return map
  }
}
