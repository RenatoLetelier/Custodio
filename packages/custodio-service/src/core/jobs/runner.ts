import { BackupError, type BackupEngine, type RunSummary } from '../backup/engine.js'
import type { VerificationService, VerificationSummary } from '../backup/verification.js'
import type { JobFilter } from '../ports/store.js'
import type { Core } from '../shared/context.js'
import { DomainError, isAbortError, notFound } from '../shared/errors.js'
import type { Job, JobError, JobKind, JobProgress, JobStatus, JobTrigger, Policy } from '../shared/model.js'

export interface StartOptions {
  actor: string
  trigger?: JobTrigger
  scheduledFor?: string | null
}

export interface BackupStartOptions extends StartOptions {
  dryRun?: boolean
  mirrorDryRunJobId?: string | null
}

export type JobListener = (job: Job) => void

type Work = (job: Job, signal: AbortSignal, progress: (p: JobProgress) => void) => Promise<Record<string, unknown>>

interface Spec {
  kind: JobKind
  policy: Policy | null
  options: StartOptions & { dryRun?: boolean }
  lock: boolean
}

const EMPTY_PROGRESS: JobProgress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }
const PROGRESS_EVERY_MS = 250
// Disk scans run on their own (and every minute while they fail): only the latest ones are kept
const SCANS_KEPT = 20
const FINISHED: JobStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'skipped']

export interface InventoryTask {
  scan(): Promise<Record<string, unknown>>
}

// Long operations run here: 202 + job id for the API, one at a time per policy, cancellable
export class JobRunner {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<Job> }>()
  private readonly listeners = new Set<JobListener>()
  // The last progress saved of each running job, and the latest one reported (saved when the job ends)
  private readonly lastProgress = new Map<string, { at: number; phase: JobProgress['phase']; latest: JobProgress }>()

  constructor(
    private readonly core: Core,
    private readonly engine: BackupEngine,
    private readonly verifier: VerificationService,
    private readonly inventory: InventoryTask
  ) {}

  onUpdate(listener: JobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(jobId: string): Job {
    const job = this.core.store.jobs.get(jobId)
    if (!job) throw notFound('el trabajo', jobId)
    return job
  }

  list(filter?: JobFilter): Job[] {
    return this.core.store.jobs.list(filter)
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId)
  }

  // After a crash nothing is really running: close the books and free the locks
  recover(): string[] {
    const { store, clock } = this.core
    return store.transaction(() => {
      store.locks.releaseAll()
      const stale = store.jobs.list({ status: ['queued', 'running'], limit: 10_000 })
      for (const job of stale) {
        store.jobs.update({
          ...job,
          status: 'interrupted',
          finishedAt: clock.now().toISOString(),
          error: { code: 'service_restarted', message: 'El servicio se detuvo mientras este trabajo corría.' }
        })
      }
      return stale.map((j) => j.id)
    })
  }

  startBackup(policyId: string, options: BackupStartOptions): Job {
    const policy = this.policy(policyId)
    return this.launch({ kind: 'backup', policy, options, lock: true }, (job, signal, progress) =>
      this.engine.run(policy, {
        jobId: job.id,
        dryRun: options.dryRun ?? false,
        mirrorDryRunJobId: options.mirrorDryRunJobId ?? null,
        signal,
        onProgress: progress
      })
    )
  }

  startVerification(policyId: string, options: StartOptions & { samplePercent?: number }): Job {
    const policy = this.policy(policyId)
    return this.launch({ kind: 'verification', policy, options, lock: true }, (job, signal, progress) =>
      this.verifier.verify(policy, job.id, options.samplePercent ?? policy.verifySamplePercent, signal, progress)
    )
  }

  startScan(options: StartOptions): Job {
    const active = this.core.store.jobs.list({ kinds: ['inventory_scan'], status: ['running'], limit: 1 })[0]
    if (active && this.running.has(active.id)) return active
    return this.launch({ kind: 'inventory_scan', policy: null, options, lock: false }, () => this.inventory.scan())
  }

  // Other long operations (disk repair) that are not tied to a policy
  startTask(kind: JobKind, options: StartOptions, work: (signal: AbortSignal) => Promise<Record<string, unknown>>): Job {
    return this.launch({ kind, policy: null, options, lock: false }, (_job, signal) => work(signal))
  }

  // Answers at once: the job says it is being cancelled, and stops at its next safe point
  cancel(jobId: string, actor: string): Job {
    const job = this.get(jobId)
    const entry = this.running.get(jobId)
    if (FINISHED.includes(job.status)) throw new DomainError('conflict', 'Ese trabajo ya terminó.')
    const now = this.core.clock.now().toISOString()
    if (!job.cancelRequestedAt) this.core.audit.record({ actor, action: 'job.cancel_requested', target: jobId, details: { kind: job.kind } })
    if (entry) {
      const requested: Job = { ...job, cancelRequestedAt: job.cancelRequestedAt ?? now }
      this.core.store.jobs.update(requested)
      this.notify(requested)
      entry.controller.abort(new DOMException('Cancelado por el usuario', 'AbortError'))
      return requested
    }
    const cancelled: Job = { ...job, status: 'cancelled', finishedAt: now, cancelRequestedAt: job.cancelRequestedAt ?? now }
    this.core.store.jobs.update(cancelled)
    this.notify(cancelled)
    return cancelled
  }

  settled(jobId: string): Promise<Job> {
    return this.running.get(jobId)?.done ?? Promise.resolve(this.get(jobId))
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()].map((r) => r.done))
  }

  private policy(policyId: string): Policy {
    const policy = this.core.store.policies.get(policyId)
    if (!policy) throw notFound('la copia programada', policyId)
    return policy
  }

  private launch(spec: Spec, work: Work): Job {
    const { store, clock } = this.core
    const now = clock.now().toISOString()
    const job: Job = {
      id: this.core.newId(),
      kind: spec.kind,
      status: 'running',
      trigger: spec.options.trigger ?? 'manual',
      policyId: spec.policy?.id ?? null,
      projectId: spec.policy?.projectId ?? null,
      scheduledFor: spec.options.scheduledFor ?? null,
      dryRun: spec.options.dryRun ?? false,
      progress: { ...EMPTY_PROGRESS },
      result: null,
      error: null,
      requestedBy: spec.options.actor,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      cancelRequestedAt: null
    }

    const started = store.transaction(() => {
      if (spec.lock && spec.policy && !store.locks.acquire(spec.policy.id, job.id, now)) {
        store.jobs.insert({
          ...job,
          status: 'skipped',
          startedAt: null,
          finishedAt: now,
          error: {
            code: 'policy_locked',
            message: 'La ejecución anterior de esta copia sigue en curso; esta se omitió.',
            details: { runningJobId: store.locks.holder(spec.policy.id) }
          }
        })
        return false
      }
      store.jobs.insert(job)
      return true
    })
    if (!started) return this.get(job.id)

    const controller = new AbortController()
    const done = this.execute(job, spec, work, controller.signal)
    this.running.set(job.id, { controller, done })
    void done.finally(() => this.running.delete(job.id))
    this.notify(job)
    return job
  }

  private async execute(job: Job, spec: Spec, work: Work, signal: AbortSignal): Promise<Job> {
    // Let the caller answer 202 before the work begins
    await Promise.resolve()
    let final: Job
    try {
      const result = await work(job, signal, (progress) => this.progress(job.id, progress))
      final = this.succeed(job.id, spec, result)
    } catch (error) {
      final = this.fail(job.id, spec, error)
    } finally {
      if (spec.lock && spec.policy) this.core.store.locks.release(spec.policy.id, job.id)
      this.lastProgress.delete(job.id)
      if (spec.kind === 'inventory_scan') this.core.store.jobs.prune('inventory_scan', SCANS_KEPT)
    }
    this.notify(final)
    return final
  }

  // At most every PROGRESS_EVERY_MS, except a change of phase and the last file
  private progress(jobId: string, progress: JobProgress): void {
    const now = Date.now()
    const last = this.lastProgress.get(jobId)
    const finished = progress.filesTotal > 0 && progress.filesDone >= progress.filesTotal
    if (last && now - last.at < PROGRESS_EVERY_MS && last.phase === progress.phase && !finished) {
      last.latest = progress
      return
    }
    this.lastProgress.set(jobId, { at: now, phase: progress.phase, latest: progress })
    const job = this.core.store.jobs.get(jobId)
    if (!job) return
    const updated = { ...job, progress }
    this.core.store.jobs.update(updated)
    this.notify(updated)
  }

  private succeed(jobId: string, spec: Spec, result: Record<string, unknown>): Job {
    const { store, clock, events } = this.core
    return store.transaction(() => {
      const job = this.withLatestProgress(jobId)
      const now = clock.now().toISOString()
      let status: JobStatus = 'succeeded'
      let error: JobError | null = null

      if (spec.kind === 'backup' && spec.policy) {
        const summary = result as RunSummary
        if (summary.interrupted) {
          status = 'interrupted'
          error = { code: summary.interrupted, message: 'Fuera del horario permitido: la copia sigue en la próxima ventana.' }
        } else if (summary.filesFailed > 0) {
          status = 'failed'
          error = { code: 'files_failed', message: `${summary.filesFailed} archivo(s) no se pudieron copiar.`, details: summary.failed }
        }
        if (!job.dryRun && status === 'succeeded') {
          const policy = store.policies.get(spec.policy.id)
          if (policy) store.policies.update({ ...policy, lastSuccessAt: now, overdueSince: null })
          events.publish('backup.completed', {
            jobId,
            policyId: spec.policy.id,
            projectId: spec.policy.projectId,
            filesCopied: summary.filesCopied,
            bytesCopied: summary.bytesCopied,
            filesSkipped: summary.filesSkipped,
            filesDeleted: summary.filesDeleted,
            durationMs: summary.durationMs
          })
        }
        if (!job.dryRun && status === 'failed' && error) this.publishFailure(spec.policy, jobId, error)
      }
      if (spec.kind === 'verification' && (result as VerificationSummary).corrupted.length > 0) {
        status = 'failed'
        error = { code: 'corruption_detected', message: 'Se encontraron copias dañadas.' }
      }

      const final: Job = { ...job, status, error, result, finishedAt: now }
      store.jobs.update(final)
      return final
    })
  }

  private fail(jobId: string, spec: Spec, cause: unknown): Job {
    const { store, clock } = this.core
    return store.transaction(() => {
      const job = this.withLatestProgress(jobId)
      const now = clock.now().toISOString()
      if (isAbortError(cause)) {
        const cancelled: Job = { ...job, status: 'cancelled', finishedAt: now, error: { code: 'cancelled', message: 'Cancelado por el usuario.' } }
        store.jobs.update(cancelled)
        return cancelled
      }
      const error: JobError =
        cause instanceof BackupError || cause instanceof DomainError
          ? { code: cause.code, message: cause.message, details: cause.details }
          : { code: 'unexpected', message: cause instanceof Error ? cause.message : String(cause) }
      const failed: Job = { ...job, status: 'failed', finishedAt: now, error }
      store.jobs.update(failed)
      if (spec.kind === 'backup' && spec.policy && !job.dryRun) this.publishFailure(spec.policy, jobId, error)
      this.core.logger.error('job failed', { jobId, kind: job.kind, error })
      return failed
    })
  }

  private withLatestProgress(jobId: string): Job {
    const job = this.get(jobId)
    const latest = this.lastProgress.get(jobId)?.latest
    return latest ? { ...job, progress: latest } : job
  }

  private publishFailure(policy: Policy, jobId: string, error: JobError): void {
    this.core.events.publish('backup.failed', { jobId, policyId: policy.id, projectId: policy.projectId, code: error.code, message: error.message })
  }

  private notify(job: Job): void {
    for (const listener of this.listeners) listener(job)
  }
}
