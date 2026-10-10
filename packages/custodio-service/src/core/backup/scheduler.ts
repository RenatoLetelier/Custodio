import type { DeletionService } from '../allocation/deletions.js'
import type { JobRunner } from '../jobs/runner.js'
import { SYSTEM_ACTOR, type Core } from '../shared/context.js'
import type { Job, Policy } from '../shared/model.js'
import { dueSlots, expectedIntervalMs } from './schedule.js'

// A slot found more than this late means the service was down: the run is a catch-up
export const CATCH_UP_GRACE_MS = 5 * 60 * 1000
export const TICK_EVERY_MS = 30 * 1000

export interface TickResult {
  started: Job[]
  overdue: string[]
  errors: { policyId: string; message: string }[]
}

export class Scheduler {
  private loop: AbortController | null = null

  constructor(
    private readonly core: Core,
    private readonly runner: JobRunner,
    private readonly deletions: DeletionService
  ) {}

  async tick(): Promise<TickResult> {
    const result: TickResult = { started: [], overdue: [], errors: [] }
    const now = this.core.clock.now()
    for (const policy of this.core.store.policies.list()) {
      // Each policy on its own: one broken policy never stops the rest
      try {
        this.tickPolicy(policy, now, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result.errors.push({ policyId: policy.id, message })
        this.core.logger.error('scheduler policy failed', { policyId: policy.id, message })
      }
    }
    try {
      await this.deletions.retryPending()
    } catch (error) {
      this.core.logger.error('deletion retry failed', { message: error instanceof Error ? error.message : String(error) })
    }
    return result
  }

  private tickPolicy(policy: Policy, now: Date, result: TickResult): void {
    if (policy.paused) return
    const { store } = this.core
    const { latest, count } = dueSlots(policy.cron, policy.timezone, new Date(policy.lastScheduledFor ?? policy.createdAt), now)
    if (latest) {
      const trigger = count > 1 || now.getTime() - latest.getTime() > CATCH_UP_GRACE_MS ? 'catch_up' : 'schedule'
      store.policies.update({ ...policy, lastScheduledFor: latest.toISOString() })
      result.started.push(this.runner.startBackup(policy.id, { actor: SYSTEM_ACTOR, trigger, scheduledFor: latest.toISOString() }))
    }

    const current = store.policies.get(policy.id) ?? policy
    if (this.checkOverdue(current, now)) result.overdue.push(policy.id)

    const verifyEvery = current.verifyEveryHours * 60 * 60 * 1000
    const lastVerified = Date.parse(current.lastVerifiedAt ?? current.createdAt)
    if (verifyEvery > 0 && now.getTime() - lastVerified >= verifyEvery && !store.locks.holder(policy.id)) {
      result.started.push(this.runner.startVerification(policy.id, { actor: SYSTEM_ACTOR, trigger: 'schedule' }))
    }
  }

  // Overdue: no successful copy in twice the schedule's interval. Announced once until the next success
  private checkOverdue(policy: Policy, now: Date): boolean {
    if (policy.overdueSince) return false
    const interval = expectedIntervalMs(policy.cron, policy.timezone, now)
    const reference = Date.parse(policy.lastSuccessAt ?? policy.createdAt)
    if (now.getTime() - reference <= 2 * interval) return false
    const { store, events } = this.core
    store.transaction(() => {
      store.policies.update({ ...policy, overdueSince: now.toISOString() })
      events.publish('backup.overdue', {
        policyId: policy.id,
        projectId: policy.projectId,
        lastSuccessAt: policy.lastSuccessAt,
        expectedIntervalMs: interval,
        overdueSince: now.toISOString()
      })
    })
    return true
  }

  start(everyMs = TICK_EVERY_MS): void {
    if (this.loop) return
    const loop = new AbortController()
    this.loop = loop
    void (async () => {
      while (!loop.signal.aborted) {
        await this.tick().catch((error: unknown) => this.core.logger.error('scheduler tick failed', { message: String(error) }))
        await this.core.clock.sleep(everyMs, loop.signal).catch(() => undefined)
      }
    })()
  }

  stop(): void {
    this.loop?.abort()
    this.loop = null
  }
}
