import type { Job } from '../api/types'
import { t, type MessageKey } from '../i18n'
import { formatBytes, formatNumber, formatPercent, formatRelative } from '../i18n/format'

export const JOB_TONE: Record<Job['status'], 'ok' | 'error' | 'warn' | 'muted' | 'accent'> = {
  succeeded: 'ok',
  failed: 'error',
  interrupted: 'warn',
  cancelled: 'muted',
  skipped: 'muted',
  running: 'accent',
  queued: 'muted'
}

export const isActive = (job: Job): boolean => job.status === 'running' || job.status === 'queued'
export const isStopping = (job: Job): boolean => isActive(job) && job.cancelRequestedAt !== null
// Copies and their review stop half way; a disk repair or a disk search runs to the end
export const canStop = (job: Job): boolean => job.kind === 'backup' || job.kind === 'verification'
export const isScanning = (job: Job): boolean => job.progress.phase === 'scanning'

export const percentOf = (job: Job): number =>
  job.progress.bytesTotal > 0 ? (job.progress.bytesDone / job.progress.bytesTotal) * 100 : job.status === 'succeeded' ? 100 : 0

// Nothing to measure against yet (preparing, listing folders) or ever (a disk repair): the bar moves without a percentage
export const isIndeterminate = (job: Job): boolean => !canStop(job) || job.progress.phase === undefined || isScanning(job) || job.progress.bytesTotal === 0

export const reviewedOf = (job: Job): string => t('jobs.reviewed', { count: formatNumber(job.progress.filesDone, 0) })

// What the job is doing right now, in a few words: "Copiando", "Buscando discos"
export function doingOf(job: Job): string {
  if (isStopping(job)) return t('jobs.stopping')
  if (job.kind === 'backup') return job.progress.phase ? t(`jobs.phase.${job.progress.phase}`) : t('jobs.preparing')
  if (job.kind === 'verification') return t('jobs.phase.verifying')
  return t(`jobs.doing.${job.kind}` as MessageKey)
}

// "Revisando qué falta copiar… Archivos revisados: 1.234", or just "Copiando…" (the percentage goes beside it)
export function statusOf(job: Job): string {
  if (isScanning(job) && !isStopping(job)) return t('jobs.progress', { doing: doingOf(job), detail: reviewedOf(job) })
  return t('jobs.working', { doing: doingOf(job) })
}

// One line with the percentage, for compact places
export function describeProgress(job: Job): string {
  if (isIndeterminate(job) || isStopping(job)) return statusOf(job)
  return t('jobs.progress', { doing: doingOf(job), detail: formatPercent(percentOf(job)) })
}

export function hintOf(job: Job): string | null {
  if (isStopping(job)) return t('jobs.stoppingHint')
  if (job.progress.phase === 'checking') return t('jobs.checkingHint')
  if (job.kind === 'repair') return t('jobs.repairHint')
  return null
}

export const startedOf = (job: Job): string | null => (job.startedAt ? t('jobs.started', { when: formatRelative(job.startedAt) }) : null)

const count = (value: unknown): string => formatNumber(Number(value ?? 0), 0)

// How a finished job went, in a sentence: what it did, or why it stopped
export function resultOf(job: Job): string | null {
  if (isActive(job)) return null
  const result = job.result ?? {}
  if (job.status === 'succeeded') {
    if (job.kind === 'backup' && job.dryRun) {
      return t('jobs.result.simulated', { files: count(result.plannedCopies), deletions: count((result.plannedDeletions as unknown[] | undefined)?.length) })
    }
    if (job.kind === 'backup') {
      const upToDate = count(result.filesUpToDate)
      if (Number(result.filesCopied ?? 0) === 0) return t('jobs.result.nothingNew', { upToDate })
      return t('jobs.result.copied', { files: count(result.filesCopied), bytes: formatBytes(Number(result.bytesCopied ?? 0)), upToDate })
    }
    if (job.kind === 'verification') return t('jobs.result.verified', { count: count(result.checked) })
    if (job.kind === 'repair') return t(result.repaired === false ? 'jobs.result.repairIncomplete' : 'jobs.result.repaired')
    return null
  }
  if (job.status === 'cancelled') return t(job.kind === 'backup' ? 'jobs.result.stoppedBackup' : 'jobs.result.stopped')
  // The service explains its own failures in plain Spanish; only the unforeseen ones would show a raw system message
  if (!job.error) return null
  return job.error.code === 'unexpected' ? t('jobs.result.unexpected') : job.error.message
}
