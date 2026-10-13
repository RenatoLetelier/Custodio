import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import type { Disk, Plan, ProjectView } from '../api/types'
import { DeletedFields, deletedBody, deletedFrom, deletedValid, type DeletedSettings } from '../components/DeletedFields'
import { Disclosure, ErrorNotice, Modal, PreviewDialog, type PreviewProps } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { cn, domId } from '../lib/dom'
import { diskName, folderPath } from '../lib/disks'
import { DEFAULT_SCHEDULE, WEEK_ORDER, dayName, describeSchedule, fromCron, systemTimeZone, toCron, type Schedule } from '../lib/schedule'
import { useAppState } from '../state/AppState'

type Pending = Omit<PreviewProps, 'onClose'>

interface SourceRow {
  key: string
  diskId: string
  // As people write it: "lc\prod"; empty is the whole disk
  folder: string
}

let rowKey = 0
const nextKey = (): string => String(++rowKey)
const toDisplay = (folder: string): string => folder.split(/[\\/]+/).filter(Boolean).join('\\')

// The folder the picker returned, as a disk Custodio knows and a folder inside it
function locate(path: string, disks: Disk[]): { diskId: string; folder: string } | null {
  const normal = path.replace(/\//g, '\\').toLowerCase()
  for (const disk of disks) {
    if (!disk.connected || !disk.mountPath) continue
    const root = disk.mountPath.replace(/[\\/]+$/, '').toLowerCase()
    if (normal === root || normal.startsWith(`${root}\\`)) return { diskId: disk.id, folder: toDisplay(path.slice(root.length)) }
  }
  return null
}

function DeleteFromCopiesDialog({ project, onClose, onPreview }: { project: ProjectView; onClose: () => void; onPreview: (p: Pending) => void }) {
  const { refresh } = useAppState()
  const sources = project.assignments.filter((a) => a.role === 'storage')
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [path, setPath] = useState('')
  const [error, setError] = useState<unknown>(null)

  const review = async (): Promise<void> => {
    setError(null)
    try {
      const plan = await api<Plan>('POST', `/v1/projects/${project.project.id}/deletions`, { items: [{ sourceId, path }] })
      onClose()
      onPreview({
        title: t('projects.delete.previewTitle'),
        summary: plan.preview.summary,
        lines: plan.preview.lines,
        confirmLabel: t('projects.delete.confirm'),
        danger: true,
        acknowledge: t('projects.delete.acknowledge'),
        onConfirm: async () => {
          await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
          await refresh()
        }
      })
    } catch (e) {
      setError(e)
    }
  }

  return (
    <Modal
      title={t('projects.delete.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!sourceId || path.trim() === ''} onClick={() => void review()}>
            {t('projects.delete.review')}
          </button>
        </>
      }
    >
      <div className="stack-sm">
        <p className="muted">{t('projects.delete.body')}</p>
        <label className="field-stack">
          <span>{t('projects.delete.source')}</span>
          <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          <span>{t('projects.delete.path')}</span>
          <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('projects.delete.pathExample')} />
        </label>
      </div>
      {error !== null && <ErrorNotice error={error} />}
    </Modal>
  )
}

export function ProjectEditor({ project, diskId, onDone }: { project: ProjectView | null; diskId?: string; onDone: () => void }) {
  const { disks, refresh } = useAppState()
  const policy = project?.policies[0]
  const usable = disks.filter((d) => (d.connected && d.mountPath) || project?.assignments.some((a) => a.diskId === d.id))
  const firstSource = diskId ?? usable[0]?.id ?? ''

  const [name, setName] = useState(project?.project.name ?? '')
  const [sources, setSources] = useState<SourceRow[]>(() =>
    project
      ? project.assignments.filter((a) => a.role === 'storage').map((a) => ({ key: nextKey(), diskId: a.diskId, folder: toDisplay(a.folder) }))
      : [{ key: nextKey(), diskId: firstSource, folder: '' }]
  )
  const [destinations, setDestinations] = useState<{ key: string; diskId: string }[]>(() => {
    const ids = project ? [...new Set(project.assignments.filter((a) => a.role === 'backup').map((a) => a.diskId))] : [usable.find((d) => d.id !== firstSource)?.id ?? '']
    return ids.map((id) => ({ key: nextKey(), diskId: id }))
  })
  const [schedule, setSchedule] = useState<Schedule>(() => (policy ? (fromCron(policy.cron) ?? DEFAULT_SCHEDULE) : DEFAULT_SCHEDULE))
  const [deleted, setDeleted] = useState<DeletedSettings>(() => deletedFrom(policy))
  const [limit, setLimit] = useState(policy?.maxMegabytesPerSecond ? String(policy.maxMegabytesPerSecond) : '')
  const [windowStart, setWindowStart] = useState(policy?.window?.start ?? '')
  const [windowEnd, setWindowEnd] = useState(policy?.window?.end ?? '')
  const [pending, setPending] = useState<Pending | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pickError, setPickError] = useState(false)

  const disk = (id: string) => disks.find((d) => d.id === id)
  const destinationIds = destinations.map((d) => d.diskId).filter(Boolean)
  const valid =
    name.trim() !== '' &&
    sources.length > 0 &&
    sources.every((s) => s.diskId !== '') &&
    destinationIds.length > 0 &&
    new Set(destinationIds).size === destinationIds.length &&
    (schedule.kind === 'daily' || schedule.days.length > 0) &&
    deletedValid(deleted)
  const canPick = typeof window.custodio?.chooseFolder === 'function'

  const updateSource = (key: string, patch: Partial<SourceRow>) => setSources(sources.map((s) => (s.key === key ? { ...s, ...patch } : s)))

  const pick = async (key: string): Promise<void> => {
    setPickError(false)
    const path = await window.custodio?.chooseFolder?.()
    if (!path) return
    const found = locate(path, disks)
    if (found) updateSource(key, found)
    else setPickError(true)
  }

  const review = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    // The button stays enabled (and focused) while checking, so the dialog can give the focus back to it
    if (busy || !valid) return
    setBusy(true)
    setError(null)
    try {
      const cron = toCron(schedule)
      const { plan } = await api<{ plan: Plan }>('POST', '/v1/setups', {
        ...(project ? { projectId: project.project.id } : {}),
        name: name.trim(),
        sources: sources.map((s) => ({ diskId: s.diskId, folder: s.folder })),
        destinations: destinationIds,
        schedule: { cron, timezone: policy?.timezone ?? systemTimeZone() },
        options: {
          ...deletedBody(deleted),
          maxMegabytesPerSecond: limit === '' ? null : Number(limit),
          window: windowStart && windowEnd ? { start: windowStart, end: windowEnd } : null
        }
      })
      const mirrorNow = deleted.mode === 'mirror' && policy?.mode !== 'mirror'
      setPending({
        title: mirrorNow ? t('backups.mirror.title') : t('projects.editor.previewTitle'),
        summary: plan.preview.summary,
        lines: [
          ...plan.preview.lines,
          t('projects.editor.scheduleLine', { schedule: describeSchedule(cron) }),
          ...(mirrorNow ? [t('backups.mirror.line1'), t('backups.mirror.line2'), t('backups.mirror.line3')] : [])
        ],
        confirmLabel: mirrorNow ? t('backups.mirror.confirm') : t('projects.editor.confirm'),
        ...(mirrorNow ? { danger: true, acknowledge: t('backups.mirror.acknowledge') } : {}),
        onConfirm: async () => {
          await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
          await refresh()
          onDone()
        }
      })
    } catch (e) {
      setError(e)
    }
    setBusy(false)
  }

  const remove = async (): Promise<void> => {
    if (!project) return
    setError(null)
    try {
      const { plan } = await api<{ plan: Plan }>('POST', `/v1/projects/${project.project.id}/removals`)
      setPending({
        title: t('projects.remove.previewTitle', { name: project.project.name }),
        summary: plan.preview.summary,
        lines: plan.preview.lines,
        confirmLabel: t('projects.remove.confirm'),
        danger: true,
        acknowledge: t('projects.remove.acknowledge'),
        onConfirm: async () => {
          await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
          await refresh()
          onDone()
        }
      })
    } catch (e) {
      setError(e)
    }
  }

  const diskOptions = (selected: string) =>
    usable.map((d) => (
      <option key={d.id} value={d.id} disabled={!d.connected && d.id !== selected}>
        {diskName(d)}
      </option>
    ))

  return (
    <div className="stack">
      <form className="card stack project-editor" onSubmit={(e) => void review(e)} aria-labelledby="project-editor-title" data-testid="project-editor">
        <h2 id="project-editor-title" className="card__title">
          {project ? t('projects.editor.titleEdit', { name: project.project.name }) : t('projects.editor.titleNew')}
        </h2>

        <label className="field-stack">
          <span>{t('projects.editor.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('projects.editor.namePlaceholder')} />
        </label>

        <fieldset className="field-stack editor-group">
          <legend>{t('projects.editor.sources')}</legend>
          <p className="muted">{t('projects.editor.sourcesHint')}</p>
          {sources.map((source, index) => (
            <div key={source.key} className="editor-row" data-testid="source-row">
              <label className="field-stack editor-row__disk">
                <span>{t('projects.editor.disk')}</span>
                <select className="input" value={source.diskId} onChange={(e) => updateSource(source.key, { diskId: e.target.value })}>
                  {diskOptions(source.diskId)}
                </select>
              </label>
              <label className="field-stack editor-row__folder">
                <span>{t('projects.editor.folder')}</span>
                <input
                  className="input mono"
                  value={source.folder}
                  onChange={(e) => updateSource(source.key, { folder: e.target.value })}
                  placeholder={t('projects.editor.wholeDisk')}
                  aria-describedby={domId('folder-hint', source.key)}
                />
              </label>
              <div className="editor-row__actions">
                {canPick && (
                  <button type="button" className="btn btn--sm" onClick={() => void pick(source.key)}>
                    {t('projects.editor.chooseFolder')}
                  </button>
                )}
                {sources.length > 1 && (
                  <button type="button" className="btn btn--sm btn--link" onClick={() => setSources(sources.filter((s) => s.key !== source.key))} aria-label={t('projects.editor.removeSource', { n: index + 1 })}>
                    {t('projects.editor.remove')}
                  </button>
                )}
              </div>
              <p id={domId('folder-hint', source.key)} className="form-hint editor-row__hint">
                {folderPath(disk(source.diskId), source.folder)}
              </p>
            </div>
          ))}
          {pickError && <p className="form-hint form-hint--warn">{t('projects.editor.folderOutside')}</p>}
          <div>
            <button type="button" className="btn btn--sm" onClick={() => setSources([...sources, { key: nextKey(), diskId: usable[0]?.id ?? '', folder: '' }])}>
              {t('projects.editor.addSource')}
            </button>
          </div>
        </fieldset>

        <fieldset className="field-stack editor-group">
          <legend>{t('projects.editor.destinations')}</legend>
          <p className="muted">{t('projects.editor.destinationsHint')}</p>
          {destinations.map((destination, index) => (
            <div key={destination.key} className="editor-row" data-testid="destination-row">
              <label className="field-stack editor-row__disk">
                <span>{t('projects.editor.destinationN', { n: index + 1 })}</span>
                <select className="input" value={destination.diskId} onChange={(e) => setDestinations(destinations.map((d) => (d.key === destination.key ? { ...d, diskId: e.target.value } : d)))}>
                  {diskOptions(destination.diskId)}
                </select>
              </label>
              <ul className="editor-row__copies" aria-label={t('projects.editor.copiesOf', { n: index + 1 })}>
                {sources.map((source) => (
                  <li key={source.key} className="mono">
                    {folderPath(disk(destination.diskId), source.folder)}
                  </li>
                ))}
              </ul>
              {destinations.length > 1 && (
                <div className="editor-row__actions">
                  <button type="button" className="btn btn--sm btn--link" onClick={() => setDestinations(destinations.filter((d) => d.key !== destination.key))} aria-label={t('projects.editor.removeDestination', { n: index + 1 })}>
                    {t('projects.editor.remove')}
                  </button>
                </div>
              )}
            </div>
          ))}
          {new Set(destinationIds).size !== destinationIds.length && <p className="form-hint form-hint--warn">{t('projects.editor.repeatedDestination')}</p>}
          <div>
            <button type="button" className="btn btn--sm" onClick={() => setDestinations([...destinations, { key: nextKey(), diskId: usable.find((d) => !destinationIds.includes(d.id) && !sources.some((s) => s.diskId === d.id))?.id ?? '' }])}>
              {t('projects.editor.addDestination')}
            </button>
          </div>
        </fieldset>

        <fieldset className="field-stack editor-group">
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
            <DeletedFields value={deleted} onChange={setDeleted} group="deleted" allowMirror />
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
          </div>
        </Disclosure>

        {error !== null && <ErrorNotice error={error} />}
        <div className="actions">
          <button type="button" className="btn" onClick={onDone} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={!valid} aria-busy={busy}>
            {busy ? t('projects.editor.checking') : t('projects.editor.review')}
          </button>
        </div>
      </form>

      {project && (
        <section className="card stack-sm danger-zone" aria-labelledby="danger-zone-title" data-testid="danger-zone">
          <h2 id="danger-zone-title" className="card__title">
            {t('projects.editor.danger')}
          </h2>
          <p className="muted">{t('projects.editor.dangerHint')}</p>
          <div className="actions">
            <button type="button" className="btn btn--danger-outline" onClick={() => setDeleting(true)} disabled={!project.assignments.some((a) => a.role === 'storage')}>
              {t('projects.delete.button')}
            </button>
            <button type="button" className="btn btn--danger-outline" onClick={() => void remove()}>
              {t('projects.remove.button')}
            </button>
          </div>
        </section>
      )}

      {deleting && project && <DeleteFromCopiesDialog project={project} onClose={() => setDeleting(false)} onPreview={setPending} />}
      {pending && <PreviewDialog {...pending} onClose={() => setPending(null)} />}
    </div>
  )
}
