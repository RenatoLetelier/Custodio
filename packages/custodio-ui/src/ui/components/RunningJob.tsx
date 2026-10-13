import { api } from '../api/client'
import type { Job } from '../api/types'
import { t } from '../i18n'
import { formatBytes, formatPercent } from '../i18n/format'
import { canStop, hintOf, isIndeterminate, isScanning, isStopping, percentOf, startedOf, statusOf } from '../lib/jobs'
import { useAction } from '../lib/useAction'
import { useAppState } from '../state/AppState'
import { Button, ErrorNotice, ProgressBar } from './ui'

// A job at work, the same everywhere: what it is doing, a bar that always moves, since when, and the button to stop it.
// Stopping answers at once ("Deteniendo…") even though the job finishes the file in hand first
export function RunningJob({ job, name, stoppable = true }: { job: Job; name: string; stoppable?: boolean }) {
  const { track } = useAppState()
  const { pending, error, run } = useAction()
  const measured = !isIndeterminate(job) && !isStopping(job)
  const started = startedOf(job)
  const hint = hintOf(job)
  const showFiles = measured && !isScanning(job)

  const stop = () =>
    run('stop', async () => {
      track((await api<{ job: Job }>('POST', `/v1/jobs/${job.id}/cancel`)).job)
    })

  return (
    <div className="job-live" data-testid="job-live" data-job={job.id} data-stopping={isStopping(job) || undefined}>
      <div className="job-live__header">
        <p className="job-live__status" data-testid="job-status">
          {statusOf(job)}
        </p>
        {measured && (
          <span className="job-live__percent" data-testid="job-percent">
            {formatPercent(percentOf(job))}
          </span>
        )}
        {stoppable && canStop(job) && (
          <Button variant="danger-outline" size="sm" pending={pending !== null || isStopping(job)} pendingLabel={t('jobs.working', { doing: t('jobs.stopping') })} onClick={() => void stop()}>
            {t('jobs.stop')}
          </Button>
        )}
      </div>
      <ProgressBar percent={percentOf(job)} indeterminate={!measured} label={t('activity.progressOf', { name })} />
      <p className="job-live__meta muted">
        {started}
        {showFiles && (
          <>
            {started && ' · '}
            {t('activity.files', { done: job.progress.filesDone, total: job.progress.filesTotal })}
            {' · '}
            {t('activity.bytes', { done: formatBytes(job.progress.bytesDone), total: formatBytes(job.progress.bytesTotal) })}
          </>
        )}
      </p>
      {hint && <p className="job-live__hint muted">{hint}</p>}
      {error !== null && <ErrorNotice error={error} />}
    </div>
  )
}
