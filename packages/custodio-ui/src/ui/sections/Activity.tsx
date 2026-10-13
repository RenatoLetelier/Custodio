import { RunningJob } from '../components/RunningJob'
import { Badge, EmptyState } from '../components/ui'
import { t } from '../i18n'
import { formatDateTime, formatDuration, formatRelative } from '../i18n/format'
import { JOB_TONE, resultOf } from '../lib/jobs'
import { useJobName } from '../lib/useJobName'
import { useAppState } from '../state/AppState'

const HISTORY_LIMIT = 30

export function Activity() {
  const { jobs, projects } = useAppState()
  const name = useJobName()
  const running = jobs.filter((j) => j.status === 'running' && j.kind !== 'inventory_scan')
  const queued = jobs.filter((j) => j.status === 'queued')
  const upcoming = projects
    .flatMap((p) => p.policies)
    .filter((p) => !p.paused && p.nextRunAt)
    .sort((a, b) => (a.nextRunAt as string).localeCompare(b.nextRunAt as string))
  const history = jobs.filter((j) => j.status !== 'running' && j.status !== 'queued' && j.kind !== 'inventory_scan').slice(0, HISTORY_LIMIT)

  return (
    <div className="stack">
      <section aria-labelledby="running-title">
        <h2 id="running-title" className="section-title">
          {t('activity.running')}
        </h2>
        {running.length === 0 ? (
          <EmptyState title={t('activity.empty.running')} body={t('activity.empty.runningHint')} />
        ) : (
          running.map((job) => (
            <div key={job.id} className="card job" data-testid="running-job" data-job={job.id}>
              <div className="job__name">{name(job)}</div>
              <RunningJob job={job} name={name(job)} />
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
                      <Badge tone={JOB_TONE[job.status]}>{t(`jobs.status.${job.status}`)}</Badge>
                      {resultOf(job) && <p className="job__result muted">{resultOf(job)}</p>}
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
