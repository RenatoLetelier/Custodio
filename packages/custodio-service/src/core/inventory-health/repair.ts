import { z } from 'zod'
import type { PlanService } from '../allocation/plans.js'
import type { JobRunner } from '../jobs/runner.js'
import type { Core } from '../shared/context.js'
import { DomainError, notFound } from '../shared/errors.js'
import type { Plan } from '../shared/model.js'

// Repairing touches the disk's file system: it always goes through a preview and an explicit confirmation
export class RepairService {
  constructor(
    private readonly core: Core,
    private readonly plans: PlanService,
    private readonly runner: JobRunner,
    private readonly rescan: () => Promise<unknown>
  ) {
    plans.register('repair', (plan, actor) => this.apply(plan, actor))
  }

  async preview(diskId: string, actor: string): Promise<Plan> {
    const disk = this.core.store.disks.get(diskId)
    if (!disk) throw notFound('el disco', diskId)
    if (!disk.connected || !disk.mountPath) throw new DomainError('unprocessable', `Conecta el disco ${disk.model} para poder revisarlo.`)
    const confirmation = await this.core.repairer.authorize(disk.mountPath)
    const busy = this.core.store.assignments.byDisk(disk.id).length > 0
    return this.plans.create(
      'repair',
      null,
      { diskId, confirmation },
      {
        summary: `Revisar y reparar el disco ${disk.model}.`,
        lines: [
          'Se revisará el disco y se corregirán los errores que se encuentren.',
          'Mientras dura la revisión no podrás usar el disco y no se harán copias en él.',
          'No se borra ningún archivo tuyo, pero si el disco está muy dañado conviene tener una copia al día antes de empezar.',
          ...(busy ? ['Las copias programadas que usan este disco esperarán a que termine.'] : [])
        ],
        movesData: false,
        deletesData: false,
        bytesToCopy: 0,
        filesToDelete: 0
      },
      actor
    )
  }

  private apply(plan: Plan, actor: string): Promise<Record<string, unknown>> {
    const { diskId, confirmation } = z.object({ diskId: z.string(), confirmation: z.string().nullable() }).parse(plan.payload)
    const disk = this.core.store.disks.get(diskId)
    if (!disk?.connected || !disk.mountPath) throw new DomainError('unprocessable', 'El disco ya no está conectado.')
    const mountPath = disk.mountPath
    this.core.audit.record({ actor, action: 'disk.repair_requested', target: diskId, details: { planId: plan.id, model: disk.model } })
    const job = this.runner.startTask('repair', { actor }, async (signal) => {
      const outcome = await this.core.repairer.repair(mountPath, confirmation, signal)
      await this.rescan()
      return { diskId, ...outcome }
    })
    return Promise.resolve({ job })
  }
}
