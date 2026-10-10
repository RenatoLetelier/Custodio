import { useState } from 'react'
import { api } from '../api/client'
import type { Job } from '../api/types'
import { Badge, EmptyState, ErrorNotice, ProgressBar } from '../components/ui'
import { t } from '../i18n'
import { formatBytes, formatDateTime, formatDuration, formatPercent, formatRelative } from '../i18n/format'
import { useAppState } from '../state/AppState'

const TONE: Partial<Record<Job['status'], 'ok' | 'error' | 'warn' | 'muted' | 'accent'>> = {
  succeeded: 'ok',
  failed: 'error',
  interrupted: 'warn',
  cancelled: 'muted',
  skipped: 'muted',
  running: 'accent',
  queued: 'muted'
}

const HISTORY_LIMIT = 30

function useJobName(): (job: Job) => string {
  const { projects } = useAppState()
  const policies = projects.flatMap((p) => p.policies)
  return (job) => {
    const policy = policies.find((p) => p.id === job.policyId)
    if (job.kind === 'backup' && policy) return t(job.dryRun ? 'activity.name.dryRun' : 'activity.name.backup', { name: policy.name })
    if (job.kind === 'verification' && policy) return t('activity.name.verification', { name: policy.name })
    return t(`jobs.kind.${job.kind}`)
  }
}

const percentOf = (job: Job): number => (job.progress.bytesTotal > 0 ? (job.progress.bytesDone / job.progress.bytesTotal) * 100 : job.status === 'succeeded' ? 100 : 0)

export function Activity() {
  const { jobs, projects, refresh } = useAppState()
  const name = useJobName()
  const [error, setError] = useState<unknown>(null)
  const running = jobs.filter((j) => j.status === 'running' && j.kind !== 'inventory_scan')
  const queued = jobs.filter((j) => j.status === 'queued')
  const upcoming = projects
    .flatMap((p) => p.policies)
    .filter((p) => !p.paused && p.nextRunAt)
    .sort((a, b) => (a.nextRunAt as string).localeCompare(b.nextRunAt as string))
  const history = jobs.filter((j) => j.status !== 'running' && j.status !== 'queued' && j.kind !== 'inventory_scan').slice(0, HISTORY_LIMIT)

  const cancel = async (job: Job): Promise<void> => {
    setError(null)
    try {
      await api('POST', `/v1/jobs/${job.id}/cancel`)
      await refresh()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <div className="stack">
      {error !== null && <ErrorNotice error={error} />}
      <section aria-labelledby="running-title">
        <h2 id="running-title" className="section-title">
          {t('activity.running')}
        </h2>
        {running.length === 0 ? (
          <EmptyState title={t('activity.empty.running')} body={t('activity.empty.runningHint')} />
        ) : (
          running.map((job) => (
            <div key={job.id} className="card job" data-testid="running-job" data-job={job.id}>
              <div className="job__header">
                <div>
                  <div className="job__name">{name(job)}</div>
                  <div className="muted">
                    {t('activity.files', { done: job.progress.filesDone, total: job.progress.filesTotal })}
                    {' · '}
                    {t('activity.bytes', { done: formatBytes(job.progress.bytesDone), total: formatBytes(job.progress.bytesTotal) })}
                  </div>
                </div>
                <div className="job__percent" data-testid="job-percent">
                  {formatPercent(percentOf(job))}
                </div>
                <button type="button" className="btn btn--danger-outline" onClick={() => void cancel(job)}>
                  {t('common.cancel')}
                </button>
              </div>
              <ProgressBar percent={percentOf(job)} label={t('activity.progressOf', { name: name(job) })} />
            </div>
          ))
        )}
      </section>

      <section aria-labelledby="queue-title">
        <h2 id="queue-title" className="section-title">
          {t('activity.queue')}
        </h2>
        {queued.length === 0 && upcoming.length === 0 ? (
          <EmptyState title={t('activity.empty.queue')} body={t('activity.empty.queueHint')} />
        ) : (
          <div className="card">
            <table className="table" data-testid="queue">
              <tbody>
                {queued.map((job) => (
                  <tr key={job.id}>
                    <td className="table__primary">{name(job)}</td>
                    <td className="muted">{t('activity.waiting')}</td>
                  </tr>
                ))}
                {upcoming.map((policy) => (
                  <tr key={policy.id}>
                    <td className="table__primary">{policy.name}</td>
                    <td className="muted">{t('activity.scheduled', { when: formatRelative(policy.nextRunAt as string), date: formatDateTime(policy.nextRunAt as string) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="history-title">
        <h2 id="history-title" className="section-title">
          {t('activity.history')}
        </h2>
        {history.length === 0 ? (
          <EmptyState title={t('activity.empty.history')} body={t('activity.empty.historyHint')} />
        ) : (
          <div className="card">
            <table className="table" data-testid="history">
              <thead>
                <tr>
                  <th scope="col">{t('activity.columns.what')}</th>
                  <th scope="col">{t('activity.columns.result')}</th>
                  <th scope="col">{t('activity.columns.when')}</th>
                  <th scope="col">{t('activity.columns.duration')}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((job) => (
                  <tr key={job.id} data-job={job.id}>
                    <td className="table__primary">{name(job)}</td>
                    <td>
                      <Badge tone={TONE[job.status] ?? 'muted'}>{t(`jobs.status.${job.status}`)}</Badge>
                    </td>
                    <td className="muted">{job.finishedAt ? formatRelative(job.finishedAt) : t('common.none')}</td>
                    <td className="muted">{job.startedAt && job.finishedAt ? formatDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : t('common.none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
