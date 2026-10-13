import { api } from '../api/client'
import type { Policy, ProjectView } from '../api/types'
import { LastRun, policyJobs, useRunNow } from '../components/PolicyRun'
import { RunningJob } from '../components/RunningJob'
import { Badge, Button, EmptyState, ErrorNotice } from '../components/ui'
import { t } from '../i18n'
import { formatDateTime, formatList, formatRelative } from '../i18n/format'
import { domId } from '../lib/dom'
import { folderPath } from '../lib/disks'
import { describeSchedule } from '../lib/schedule'
import { useNavigate } from '../navigation'
import { useAppState } from '../state/AppState'

// One scheduled copy: when it runs, how the last one went, and the buttons to run, stop or pause it.
// What it copies and how is set in its project
function PolicyCard({ policy, project }: { policy: Policy; project: ProjectView }) {
  const { jobs, disks, refresh } = useAppState()
  const navigate = useNavigate()
  const { pending, error, run, runNow } = useRunNow()
  const paths = (ids: string[]) =>
    formatList(
      ids.map((id) => {
        const assignment = project.assignments.find((a) => a.id === id)
        return assignment ? folderPath(disks.find((d) => d.id === assignment.diskId), assignment.folder) : ''
      })
    )
  const { running, last } = policyJobs(jobs, policy.id)
  const titleId = domId('policy', policy.id)

  const togglePause = () =>
    run('pause', async () => {
      await api('PATCH', `/v1/policies/${policy.id}`, { paused: !policy.paused })
      await refresh()
    })

  return (
    <article className="card policy" data-testid="policy-card" data-policy={policy.id} aria-labelledby={titleId}>
      <header className="policy__header">
        <h3 id={titleId} className="card__title">
          {project.project.name}
        </h3>
        <div className="chips">
          {policy.paused && <Badge tone="muted">{t('backups.paused')}</Badge>}
          {policy.mode !== 'append' && <Badge tone="warn">{t(`backups.mode.${policy.mode}`)}</Badge>}
        </div>
      </header>
      <p data-testid="policy-schedule">{describeSchedule(policy.cron)}</p>
      <p data-testid="policy-next">
        {policy.paused || !policy.nextRunAt ? t('backups.noNext') : t('backups.next', { when: formatRelative(policy.nextRunAt), date: formatDateTime(policy.nextRunAt) })}
      </p>
      <p className="muted">{t('backups.copies', { sources: paths(policy.sources), destinations: paths(policy.destinations) })}</p>
      {policy.mode === 'retention' && (
        <p className="muted" data-testid="policy-retention">
          {t('backups.retentionNote', { days: policy.retentionDays })}
        </p>
      )}
      {!running && last && <LastRun job={last} />}
      {policy.overdueSince && <p className="alert alert--warn-inline">{t('backups.overdue')}</p>}
      {running && <RunningJob job={running} name={project.project.name} />}
      {error !== null && <ErrorNotice error={error} />}
      <div className="actions">
        <Button variant="primary" disabled={!!running} pending={pending === 'run'} pendingLabel={t('backups.starting')} onClick={() => void runNow(policy.id)}>
          {t('backups.runNow')}
        </Button>
        <Button pending={pending === 'pause'} pendingLabel={t(policy.paused ? 'backups.resuming' : 'backups.pausing')} onClick={() => void togglePause()}>
          {t(policy.paused ? 'backups.resume' : 'backups.pause')}
        </Button>
        <Button variant="link" onClick={() => navigate('projects', { kind: 'editProject', projectId: project.project.id })}>
          {t('backups.change')}
        </Button>
      </div>
    </article>
  )
}

export function Backups() {
  const { projects } = useAppState()
  const navigate = useNavigate()
  const scheduled = projects.flatMap((p) => p.policies.map((policy) => ({ policy, project: p })))
  // A project without a schedule (left by an older version) is the first one to finish
  const unscheduled = projects.find((p) => p.policies.length === 0)
  const schedule = () => navigate('projects', unscheduled ? { kind: 'editProject', projectId: unscheduled.project.id } : { kind: 'newProject' })

  if (projects.length === 0) {
    return (
      <EmptyState
        title={t('backups.empty.title')}
        body={t('backups.empty.noProjects')}
        action={
          <button type="button" className="btn btn--primary" onClick={() => navigate('projects', { kind: 'newProject' })}>
            {t('projects.new')}
          </button>
        }
      />
    )
  }

  if (scheduled.length === 0) {
    return (
      <EmptyState
        title={t('backups.empty.title')}
        body={t('backups.empty.body')}
        action={
          <button type="button" className="btn btn--primary" onClick={schedule}>
            {t('backups.empty.action')}
          </button>
        }
      />
    )
  }

  return (
    <div className="stack">
      <p className="muted">{t('backups.intro')}</p>
      <div className="toolbar">
        <button type="button" className="btn" onClick={schedule}>
          {t('backups.new')}
        </button>
      </div>
      {scheduled.map(({ policy, project }) => (
        <PolicyCard key={policy.id} policy={policy} project={project} />
      ))}
    </div>
  )
}
