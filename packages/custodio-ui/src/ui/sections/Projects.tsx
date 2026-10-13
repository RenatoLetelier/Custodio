import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { Job, ProjectView } from '../api/types'
import { Badge, EmptyState, ErrorNotice, Icon } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatDateTime, formatRelative } from '../i18n/format'
import { domId } from '../lib/dom'
import { folderPath } from '../lib/disks'
import { describeSchedule } from '../lib/schedule'
import { useIntent } from '../navigation'
import { useAppState } from '../state/AppState'
import { ProjectEditor } from './ProjectEditor'

type View = { kind: 'list' } | { kind: 'new'; diskId?: string } | { kind: 'edit'; projectId: string }

const JOB_TONE: Partial<Record<Job['status'], 'ok' | 'error' | 'warn' | 'muted'>> = { succeeded: 'ok', failed: 'error', interrupted: 'warn', cancelled: 'muted', skipped: 'muted' }

function ProjectCard({ view, onEdit }: { view: ProjectView; onEdit: () => void }) {
  const { disks, jobs, refresh } = useAppState()
  const [error, setError] = useState<unknown>(null)
  const policy = view.policies[0]
  const disk = (id: string) => disks.find((d) => d.id === id)
  const sources = view.assignments.filter((a) => a.role === 'storage')
  const copies = view.assignments.filter((a) => a.role === 'backup')
  const policyJobs = policy ? jobs.filter((j) => j.policyId === policy.id && j.kind === 'backup' && !j.dryRun) : []
  const running = policyJobs.find((j) => j.status === 'running')
  const last = policyJobs.find((j) => j.status !== 'running' && j.finishedAt)
  const titleId = domId('project', view.project.id)

  const runNow = async (): Promise<void> => {
    if (!policy) return
    setError(null)
    try {
      await api('POST', `/v1/policies/${policy.id}/runs`, {})
      await refresh()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <article className="card project-card" data-testid="project-card" data-project={view.project.id} aria-labelledby={titleId}>
      <header className="project-card__header">
        <h3 id={titleId} className="card__title">
          {view.project.name}
        </h3>
        <div className="chips">
          {policy?.paused && <Badge tone="muted">{t('backups.paused')}</Badge>}
          {running && <Badge tone="accent">{t('jobs.status.running')}</Badge>}
          {!running && last && (
            <Badge tone={JOB_TONE[last.status] ?? 'muted'}>{t('projects.card.last', { status: t(`jobs.status.${last.status}`), when: formatRelative(last.finishedAt as string) })}</Badge>
          )}
          {!running && !last && policy && <Badge tone="muted">{t('projects.card.never')}</Badge>}
        </div>
      </header>

      <dl className="project-card__facts">
        <div>
          <dt>{t('projects.card.sources')}</dt>
          <dd>
            <ul className="path-list">
              {sources.map((a) => (
                <li key={a.id}>
                  <Icon name="folder" size={16} />
                  <span className="mono">{folderPath(disk(a.diskId), a.folder)}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>{t('projects.card.copies')}</dt>
          <dd>
            {copies.length === 0 ? (
              <span className="muted">{t('projects.card.noCopies')}</span>
            ) : (
              <ul className="path-list">
                {copies.map((a) => (
                  <li key={a.id}>
                    <Icon name="disk" size={16} />
                    <span className="mono">{folderPath(disk(a.diskId), a.folder)}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('projects.card.when')}</dt>
          <dd data-testid="project-schedule">
            {policy ? describeSchedule(policy.cron) : t('projects.card.noSchedule')}
            {policy && !policy.paused && policy.nextRunAt && <span className="muted">{t('projects.card.next', { when: formatDateTime(policy.nextRunAt) })}</span>}
          </dd>
        </div>
      </dl>

      {view.topology.warnings
        .filter((w) => w.code === 'no_source' || w.code === 'no_backup')
        .map((w) => (
          <p key={`${w.code}-${w.assignmentId ?? ''}`} className="alert alert--warn-inline" data-testid="project-warning">
            {t(`projects.warning.${w.code}` as MessageKey, { folder: view.assignments.find((a) => a.id === w.assignmentId)?.label ?? '' })}
          </p>
        ))}
      {error !== null && <ErrorNotice error={error} />}
      <div className="actions">
        {policy && (
          <button type="button" className="btn btn--primary" disabled={!!running} onClick={() => void runNow()}>
            {t('backups.runNow')}
          </button>
        )}
        <button type="button" className="btn" onClick={onEdit}>
          <Icon name="edit" size={16} />
          {t('projects.card.edit')}
        </button>
      </div>
    </article>
  )
}

export function Projects() {
  const { projects } = useAppState()
  const { intent, clear } = useIntent()
  // Sent here from Respaldos or Discos: open what they asked for, once
  const [view, setView] = useState<View>(() =>
    !intent ? { kind: 'list' } : intent.kind === 'editProject' ? { kind: 'edit', projectId: intent.projectId } : { kind: 'new', diskId: intent.diskId }
  )
  useEffect(() => {
    if (intent) clear()
  }, [intent, clear])

  if (view.kind !== 'list') {
    const project = view.kind === 'edit' ? (projects.find((p) => p.project.id === view.projectId) ?? null) : null
    if (view.kind === 'edit' && !project) return null
    return <ProjectEditor key={view.kind === 'edit' ? view.projectId : 'new'} project={project} diskId={view.kind === 'new' ? view.diskId : undefined} onDone={() => setView({ kind: 'list' })} />
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        title={t('projects.empty.title')}
        body={t('projects.empty.body')}
        action={
          <button type="button" className="btn btn--primary" onClick={() => setView({ kind: 'new' })}>
            {t('projects.empty.action')}
          </button>
        }
      />
    )
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" className="btn btn--primary" onClick={() => setView({ kind: 'new' })}>
          <Icon name="plus" size={16} />
          {t('projects.new')}
        </button>
      </div>
      {projects.map((p) => (
        <ProjectCard key={p.project.id} view={p} onEdit={() => setView({ kind: 'edit', projectId: p.project.id })} />
      ))}
    </div>
  )
}
