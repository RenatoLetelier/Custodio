import type { Clock } from '../ports/system.js'

export const MEGABYTE = 1024 * 1024

// Paces a stream so the average since the first byte never runs ahead of the limit
export class Pacer {
  private startedAt: number | null = null
  private bytes = 0

  constructor(
    private readonly clock: Clock,
    private readonly bytesPerSecond: number
  ) {}

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    const now = this.clock.now().getTime()
    this.startedAt ??= now
    this.bytes += bytes
    const due = this.startedAt + (this.bytes / this.bytesPerSecond) * 1000
    if (due > now) await this.clock.sleep(due - now, signal)
  }
}
