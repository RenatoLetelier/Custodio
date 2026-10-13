import { useState, type FormEvent } from 'react'
import { cn, domId } from '../lib/dom'
import { api } from '../api/client'
import type { Job, Policy, ProjectView } from '../api/types'
import { Badge, Disclosure, EmptyState, ErrorNotice, Modal, PreviewDialog, ProgressBar, type PreviewProps } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatDateTime, formatList, formatPercent, formatRelative } from '../i18n/format'
import { DEFAULT_SCHEDULE, WEEK_ORDER, dayName, describeSchedule, systemTimeZone, toCron, type Schedule } from '../lib/schedule'
import { useNavigate } from '../navigation'
import { useAppState } from '../state/AppState'

type Pending = Omit<PreviewProps, 'onClose'>

const JOB_TONE: Partial<Record<Job['status'], 'ok' | 'error' | 'warn' | 'muted'>> = { succeeded: 'ok', failed: 'error', interrupted: 'warn', cancelled: 'muted', skipped: 'muted' }

// What happens in the copy with what is deleted from the original: kept for good, or kept a few days in the copy's trash
interface DeletedSettings {
  mode: 'append' | 'retention'
  retentionDays: string
  maxDeletePercent: string
}

const DEFAULT_DELETED: DeletedSettings = { mode: 'append', retentionDays: '30', maxDeletePercent: '10' }

function deletedValid(value: DeletedSettings): boolean {
  if (value.mode === 'append') return true
  const days = Number(value.retentionDays)
  const percent = Number(value.maxDeletePercent)
  return Number.isInteger(days) && days >= 1 && days <= 3650 && value.maxDeletePercent !== '' && percent >= 0 && percent <= 100
}

const deletedBody = (value: DeletedSettings) =>
  value.mode === 'append' ? { mode: 'append' } : { mode: 'retention', retentionDays: Number(value.retentionDays), maxDeletePercent: Number(value.maxDeletePercent) }

function DeletedFields({ value, onChange, group }: { value: DeletedSettings; onChange: (value: DeletedSettings) => void; group: string }) {
  return (
    <fieldset className="field-stack">
      <legend>{t('backups.form.deleted')}</legend>
      {(['append', 'retention'] as const).map((mode) => (
        <label key={mode} className="check">
          <input type="radio" name={group} checked={value.mode === mode} onChange={() => onChange({ ...value, mode })} />
          <span>{t(`backups.form.deletedMode.${mode}`)}</span>
        </label>
      ))}
      {value.mode === 'retention' && (
        <>
          <p className="muted">{t('backups.form.retentionHint')}</p>
          <label className="field">
            <span>{t('backups.form.retentionDays')}</span>
            <input className="input input--sm" type="number" min={1} max={3650} value={value.retentionDays} onChange={(e) => onChange({ ...value, retentionDays: e.target.value })} />
          </label>
          <label className="field-stack">
            <span>{t('backups.form.maxDelete')}</span>
            <input className="input input--sm" type="number" min={0} max={100} value={value.maxDeletePercent} onChange={(e) => onChange({ ...value, maxDeletePercent: e.target.value })} />
          </label>
        </>
      )}
    </fieldset>
  )
}

function DeletedDialog({ policy, onClose }: { policy: Policy; onClose: () => void }) {
  const { refresh } = useAppState()
  const [value, setValue] = useState<DeletedSettings>({
    mode: policy.mode === 'retention' ? 'retention' : 'append',
    retentionDays: String(policy.retentionDays),
    maxDeletePercent: String(policy.maxDeletePercent)
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api('PATCH', `/v1/policies/${policy.id}`, deletedBody(value))
      await refresh()
      onClose()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('backups.deleted.title', { name: policy.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!deletedValid(value) || busy} onClick={() => void save()}>
            {t('backups.deleted.save')}
          </button>
        </>
      }
    >
      <DeletedFields value={value} onChange={setValue} group={domId('deleted', policy.id)} />
      {error !== null && <ErrorNotice error={error} />}
    </Modal>
  )
}

function NewPolicyForm({ projects, onDone }: { projects: ProjectView[]; onDone: () => void }) {
  const { refresh } = useAppState()
  const [projectId, setProjectId] = useState(projects[0]?.project.id ?? '')
  const project = projects.find((p) => p.project.id === projectId)
  const storage = project?.assignments.filter((a) => a.role === 'storage') ?? []
  const backup = project?.assignments.filter((a) => a.role === 'backup') ?? []
  const [name, setName] = useState(() => t('backups.form.defaultName'))
  const [sources, setSources] = useState<string[]>(storage.map((a) => a.id))
  const [destinations, setDestinations] = useState<string[]>(backup.map((a) => a.id))
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE)
  const [limit, setLimit] = useState('')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [deleted, setDeleted] = useState<DeletedSettings>(DEFAULT_DELETED)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  const valid = name.trim() !== '' && sources.length > 0 && destinations.length > 0 && (schedule.kind === 'daily' || schedule.days.length > 0) && deletedValid(deleted)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('POST', `/v1/projects/${projectId}/policies`, {
        name: name.trim(),
        sources,
        destinations,
        cron: toCron(schedule),
        timezone: systemTimeZone(),
        maxMegabytesPerSecond: limit === '' ? null : Number(limit),
        window: windowStart && windowEnd ? { start: windowStart, end: windowEnd } : null,
        ...deletedBody(deleted)
      })
      await refresh()
      onDone()
    } catch (e) {
      setError(e)
      setBusy(false)
    }
  }

  return (
    <form className="card stack-sm policy-form" onSubmit={(e) => void submit(e)} aria-labelledby="new-policy-title" data-testid="policy-form">
      <h2 id="new-policy-title" className="card__title">
        {t('backups.form.title')}
      </h2>
      {projects.length > 1 && (
        <label className="field-stack">
          <span>{t('backups.form.project')}</span>
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.project.id} value={p.project.id}>
                {p.project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field-stack">
        <span>{t('backups.form.name')}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset className="field-stack">
        <legend>{t('backups.form.what')}</legend>
        {storage.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" checked={sources.includes(a.id)} onChange={() => setSources(toggle(sources, a.id))} />
            <span>{a.label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field-stack">
        <legend>{t('backups.form.where')}</legend>
        {backup.map((a) => (
          <label key={a.id} className="check">
            <input type="checkbox" checked={destinations.includes(a.id)} onChange={() => setDestinations(toggle(destinations, a.id))} />
            <span>{a.label}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="field-stack">
        <legend>{t('backups.form.when')}</legend>
        <div className="segmented" role="radiogroup" aria-label={t('backups.form.when')}>
          {(['daily', 'weekly'] as const).map((kind) => (
            <label key={kind} className={cn('segmented__item', schedule.kind === kind && 'segmented__item--active')}>
              <input type="radio" className="visually-hidden" name="frequency" checked={schedule.kind === kind} onChange={() => setSchedule({ ...schedule, kind })} />
              <span>{t(`backups.form.${kind}` as MessageKey)}</span>
            </label>
          ))}
        </div>
        {schedule.kind === 'weekly' && (
          <div className="days" role="group" aria-label={t('backups.form.days')}>
            {WEEK_ORDER.map((day) => (
              <label key={day} className="check check--inline">
                <input type="checkbox" checked={schedule.days.includes(day)} onChange={() => setSchedule({ ...schedule, days: schedule.days.includes(day) ? schedule.days.filter((d) => d !== day) : [...schedule.days, day] })} />
                <span>{dayName(day)}</span>
              </label>
            ))}
          </div>
        )}
        <label className="field">
          <span>{t('backups.form.time')}</span>
          <input className="input input--sm" type="time" value={schedule.time} required onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
        </label>
        <p className="muted" data-testid="schedule-preview">
          {describeSchedule(toCron(schedule))}
        </p>
      </fieldset>
      <Disclosure label="backups.form.advanced">
        <div className="stack-sm">
          <label className="field">
            <span>{t('backups.form.limit')}</span>
            <input className="input input--sm" type="number" min={1} value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <p className="muted">{t('backups.form.windowHint')}</p>
          <div className="field-row">
            <label className="field">
              <span>{t('backups.form.windowStart')}</span>
              <input className="input input--sm" type="time" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('backups.form.windowEnd')}</span>
              <input className="input input--sm" type="time" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
            </label>
          </div>
          <DeletedFields value={deleted} onChange={setDeleted} group="deleted" />
        </div>
      </Disclosure>
      {error !== null && <ErrorNotice error={error} />}
      <div className="actions">
        <button type="button" className="btn" onClick={onDone} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn btn--primary" disabled={!valid || busy}>
          {t('backups.form.submit')}
        </button>
      </div>
    </form>
  )
}

function PolicyCard({ policy, project, onPreview }: { policy: Policy; project: ProjectView; onPreview: (p: Pending) => void }) {
  const { jobs, refresh } = useAppState()
  const [error, setError] = useState<unknown>(null)
  const [editingDeleted, setEditingDeleted] = useState(false)
  const labels = (ids: string[]) => formatList(ids.map((id) => project.assignments.find((a) => a.id === id)?.label ?? ''))
  const policyJobs = jobs.filter((j) => j.policyId === policy.id && j.kind === 'backup' && !j.dryRun)
  const running = policyJobs.find((j) => j.status === 'running')
  const last = policyJobs.find((j) => j.status !== 'running' && j.finishedAt)

  const call = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e)
    }
  }

  const mirror = (): void =>
    onPreview({
      title: t('backups.mirror.title'),
      summary: t('backups.mirror.summary', { name: policy.name }),
      lines: [t('backups.mirror.line1'), t('backups.mirror.line2'), t('backups.mirror.line3')],
      confirmLabel: t('backups.mirror.confirm'),
      danger: true,
      acknowledge: t('backups.mirror.acknowledge'),
      onConfirm: async () => {
        await api('PATCH', `/v1/policies/${policy.id}`, { mode: 'mirror', mirrorConfirmed: true })
        await refresh()
      }
    })

  return (
    <article className="card policy" data-testid="policy-card" data-policy={policy.id} aria-labelledby={domId('policy', policy.id)}>
      <header className="policy__header">
        <h3 id={domId('policy', policy.id)} className="card__title">
          {policy.name}
        </h3>
        <div className="chips">
          {policy.paused && <Badge tone="muted">{t('backups.paused')}</Badge>}
          {policy.mode !== 'append' && <Badge tone="warn">{t(`backups.mode.${policy.mode}`)}</Badge>}
        </div>
      </header>
      <p data-testid="policy-schedule">{describeSchedule(policy.cron)}</p>
      <p className="muted">{t('backups.copies', { sources: labels(policy.sources), destinations: labels(policy.destinations) })}</p>
      {policy.mode === 'retention' && (
        <p className="muted" data-testid="policy-retention">
          {t('backups.retentionNote', { days: policy.retentionDays })}
        </p>
      )}
      <p data-testid="policy-next">
        {policy.paused || !policy.nextRunAt ? t('backups.noNext') : t('backups.next', { when: formatRelative(policy.nextRunAt), date: formatDateTime(policy.nextRunAt) })}
      </p>
      {last && (
        <p className="policy__last">
          <Badge tone={JOB_TONE[last.status] ?? 'muted'}>{t(`jobs.status.${last.status}`)}</Badge>
          <span className="muted">{formatRelative(last.finishedAt as string)}</span>
        </p>
      )}
      {policy.overdueSince && <p className="alert alert--warn-inline">{t('backups.overdue')}</p>}
      {running && (
        <ProgressBar
          percent={running.progress.bytesTotal > 0 ? (running.progress.bytesDone / running.progress.bytesTotal) * 100 : 0}
          label={t('activity.progressOf', { name: policy.name })}
        />
      )}
      {running && <p className="muted">{t('backups.running', { percent: formatPercent(running.progress.bytesTotal > 0 ? (running.progress.bytesDone / running.progress.bytesTotal) * 100 : 0) })}</p>}
      {error !== null && <ErrorNotice error={error} />}
      <div className="actions">
        <button type="button" className="btn btn--primary" disabled={!!running} onClick={() => void call(() => api('POST', `/v1/policies/${policy.id}/runs`, {}))}>
          {t('backups.runNow')}
        </button>
        <button type="button" className="btn" onClick={() => void call(() => api('PATCH', `/v1/policies/${policy.id}`, { paused: !policy.paused }))}>
          {t(policy.paused ? 'backups.resume' : 'backups.pause')}
        </button>
        {policy.mode !== 'mirror' && (
          <button type="button" className="btn btn--link" onClick={() => setEditingDeleted(true)}>
            {t('backups.deleted.button')}
          </button>
        )}
        {policy.mode !== 'mirror' && (
          <button type="button" className="btn btn--link" onClick={mirror}>
            {t('backups.mirror.button')}
          </button>
        )}
      </div>
      {editingDeleted && <DeletedDialog policy={policy} onClose={() => setEditingDeleted(false)} />}
    </article>
  )
}

export function Backups() {
  const { projects } = useAppState()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const policies = projects.flatMap((p) => p.policies.map((policy) => ({ policy, project: p })))
  const canCreate = projects.some((p) => p.assignments.some((a) => a.role === 'storage') && p.assignments.some((a) => a.role === 'backup'))

  if (projects.length === 0) {
    return (
      <EmptyState
        title={t('backups.empty.title')}
        body={t('backups.empty.noProjects')}
        action={
          <button type="button" className="btn btn--primary" onClick={() => navigate('overview')}>
            {t('projects.empty.action')}
          </button>
        }
      />
    )
  }

  return (
    <div className="stack">
      {creating ? (
        <NewPolicyForm projects={projects} onDone={() => setCreating(false)} />
      ) : (
        canCreate &&
        policies.length > 0 && (
          <div className="toolbar">
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
              {t('backups.new')}
            </button>
          </div>
        )
      )}
      {policies.length === 0 && !creating && (
        <EmptyState
          title={t('backups.empty.title')}
          body={t(canCreate ? 'backups.empty.body' : 'backups.empty.needDisks')}
          action={
            canCreate ? (
              <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                {t('backups.empty.action')}
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={() => navigate('projects')}>
                {t('backups.empty.toProjects')}
              </button>
            )
          }
        />
      )}
      {policies.map(({ policy, project }) => (
        <PolicyCard key={policy.id} policy={policy} project={project} onPreview={setPending} />
      ))}
      {pending && <PreviewDialog {...pending} onClose={() => setPending(null)} />}
    </div>
  )
}
