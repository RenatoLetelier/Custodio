import { setTimeout as delay } from 'node:timers/promises'
import type { Clock } from '../../core/ports/system.js'

interface Sleeper {
  until: number
  resolve: () => void
}

// Virtual time. "instant": every sleep moves time forward on the spot. "manual": sleeps wait for advance()
export class SimClock implements Clock {
  private current: number
  private sleepers: Sleeper[] = []
  sleptMs = 0

  constructor(
    start: Date | string,
    private readonly mode: 'instant' | 'manual' = 'instant'
  ) {
    this.current = new Date(start).getTime()
  }

  now(): Date {
    return new Date(this.current)
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const wait = Math.max(0, ms)
    this.sleptMs += wait
    if (this.mode === 'instant') {
      this.current += wait
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const sleeper: Sleeper = { until: this.current + wait, resolve }
      this.sleepers.push(sleeper)
      signal?.addEventListener('abort', () => {
        this.sleepers = this.sleepers.filter((s) => s !== sleeper)
        reject(signal.reason as Error)
      })
    })
  }

  set(date: Date | string): void {
    this.current = new Date(date).getTime()
    this.wake()
  }

  advance(ms: number): void {
    this.current += ms
    this.wake()
  }

  private wake(): void {
    const due = this.sleepers.filter((s) => s.until <= this.current)
    this.sleepers = this.sleepers.filter((s) => s.until > this.current)
    for (const sleeper of due) sleeper.resolve()
  }
}

// Real time that a test can push forward: the service keeps running normally while hours pass in a second
export class ShiftableClock implements Clock {
  private offsetMs = 0

  now(): Date {
    return new Date(Date.now() + this.offsetMs)
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return delay(Math.max(0, ms), undefined, { signal })
  }

  advance(ms: number): void {
    this.offsetMs += ms
  }
}
