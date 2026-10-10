import { randomBytes } from 'node:crypto'
import type { DiskRepairer, RepairOutcome } from '../../core/ports/system.js'

// Pretends to repair a file system: hands out one-time confirmations like the helper does and takes a moment
export class SimRepairer implements DiskRepairer {
  readonly repaired: string[] = []
  outcome: RepairOutcome = { repaired: true, details: 'Revisión simulada: no se encontraron errores.' }
  durationMs = 50
  private readonly issued = new Set<string>()

  authorize(): Promise<string | null> {
    const token = randomBytes(12).toString('hex')
    this.issued.add(token)
    return Promise.resolve(token)
  }

  async repair(mountPath: string, confirmation: string | null, signal?: AbortSignal): Promise<RepairOutcome> {
    if (!confirmation || !this.issued.delete(confirmation)) throw new Error('Repair needs a valid one-time confirmation')
    await new Promise((resolve) => setTimeout(resolve, this.durationMs))
    signal?.throwIfAborted()
    this.repaired.push(mountPath)
    return this.outcome
  }
}
