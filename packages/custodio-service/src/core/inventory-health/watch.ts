import type { Clock } from '../ports/system.js'
import type { Job } from '../shared/model.js'

export const SCAN_RETRY_MS = 60 * 1000

// Health, space and connections refresh on their own. A scan that fails (at boot the helper may still be starting) is retried sooner
export class InventoryWatch {
  private loop: AbortController | null = null

  constructor(
    private readonly clock: Clock,
    private readonly scan: () => Promise<Job>,
    private readonly everyMs: number,
    private readonly retryMs = SCAN_RETRY_MS
  ) {}

  start(lastScan: Job): void {
    if (this.loop) return
    const loop = new AbortController()
    this.loop = loop
    void (async () => {
      let ok = lastScan.status === 'succeeded'
      while (!loop.signal.aborted) {
        await this.clock.sleep(ok ? this.everyMs : this.retryMs, loop.signal).catch(() => undefined)
        if (loop.signal.aborted) return
        ok = (await this.scan().catch(() => null))?.status === 'succeeded'
      }
    })()
  }

  stop(): void {
    this.loop?.abort()
    this.loop = null
  }
}
