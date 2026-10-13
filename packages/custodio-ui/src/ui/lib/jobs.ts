import type { Job } from '../api/types'
import { t } from '../i18n'
import { formatNumber, formatPercent } from '../i18n/format'

export const percentOf = (job: Job): number =>
  job.progress.bytesTotal > 0 ? (job.progress.bytesDone / job.progress.bytesTotal) * 100 : job.status === 'succeeded' ? 100 : 0

// While a backup lists its folders there is no total yet, only the files reviewed
export const isScanning = (job: Job): boolean => job.progress.phase === 'scanning'

export const reviewedOf = (job: Job): string => t('jobs.reviewed', { count: formatNumber(job.progress.filesDone, 0) })

// "Copiando… 40 %", or what the backup is doing before it copies
export function describeProgress(job: Job): string {
  const phase = job.progress.phase ?? 'copying'
  return t('jobs.progress', { phase: t(`jobs.phase.${phase}`), detail: isScanning(job) ? reviewedOf(job) : formatPercent(percentOf(job)) })
}
