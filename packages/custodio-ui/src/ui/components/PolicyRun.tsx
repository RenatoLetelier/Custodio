import { api } from '../api/client'
import type { Job } from '../api/types'
import { t } from '../i18n'
import { formatRelative } from '../i18n/format'
import { JOB_TONE, isActive, resultOf } from '../lib/jobs'
import { useAction } from '../lib/useAction'
import { useAppState } from '../state/AppState'
import { Badge } from './ui'

// The copy now under way for a policy, and the last one that ended
export function policyJobs(jobs: Job[], policyId: string): { running: Job | undefined; last: Job | undefined } {
  const own = jobs.filter((j) => j.policyId === policyId && j.kind === 'backup' && !j.dryRun)
  return { running: own.find(isActive), last: own.find((j) => !isActive(j) && j.finishedAt) }
}

// Runs a policy now: the job shows up at once, before the next refresh
export function useRunNow() {
  const { track } = useAppState()
  const action = useAction<'run' | 'pause'>()
  const runNow = (policyId: string) =>
    action.run('run', async () => {
      track((await api<{ job: Job }>('POST', `/v1/policies/${policyId}/runs`, {})).job)
    })
  return { ...action, runNow }
}

export function LastRun({ job }: { job: Job }) {
  const result = resultOf(job)
  return (
    <div className="policy__last" data-testid="last-run">
      <p className="policy__last-head">
        <Badge tone={JOB_TONE[job.status]}>{t(`jobs.status.${job.status}`)}</Badge>
        <span className="muted">{formatRelative(job.finishedAt as string)}</span>
      </p>
      {result && <p className="muted">{result}</p>}
    </div>
  )
}
