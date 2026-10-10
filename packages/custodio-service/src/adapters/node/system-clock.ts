import { setTimeout as delay } from 'node:timers/promises'
import type { Clock } from '../../core/ports/system.js'

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await delay(Math.max(0, ms), undefined, { signal })
  }
}
