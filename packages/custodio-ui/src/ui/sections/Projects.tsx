import { useState } from 'react'
import { domId } from '../lib/dom'
import { api } from '../api/client'
import type { Plan, ProjectView, Role } from '../api/types'
import { Badge, EmptyState, ErrorNotice, Modal, PreviewDialog, type PreviewProps } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { diskName as nameOf } from '../lib/disks'
import { useNavigate } from '../navigation'
import { useAppState } from '../state/AppState'

type Pending = Omit<PreviewProps, 'onClose'>

function AddDiskDialog({ project, onClose, onPreview }: { project: ProjectView; onClose: () => void; onPreview: (p: Pending) => void }) {
  const { disks, refresh } = useAppState()
  const free = disks.filter((d) => d.connected && d.state === 'unassigned')
  const [diskId, setDiskId] = useState(free[0]?.id ?? '')
  const [role, setRole] = useState<Role>('backup')
  const [error, setError] = useState<unknown>(null)

  const review = async (): Promise<void> => {
    setError(null)
    try {
      const folder = role === 'storage' ? '' : t('wizard.backupFolder')
      const { plan } = await api<{ plan: Plan }>('POST', `/v1/projects/${project.project.id}/plans`, { actions: [{ type: 'add_assignment', diskId, folder, role }] })
      onClose()
      onPreview({
        title: t('projects.add.previewTitle'),
        summary: plan.preview.summary,
        lines: plan.preview.lines,
        confirmLabel: t('projects.add.confirm'),
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
      title={t('projects.add.title', { project: project.project.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!diskId} onClick={() => void review()}>
            {t('projects.add.review')}
          </button>
        </>
      }
    >
      {free.length === 0 ? (
        <p>{t('projects.add.noDisks')}</p>
      ) : (
        <div className="stack-sm">
          <label className="field-stack">
            <span>{t('projects.add.disk')}</span>
            <select className="input" value={diskId} onChange={(e) => setDiskId(e.target.value)}>
              {free.map((d) => (
                <option key={d.id} value={d.id}>
                  {nameOf(d)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="field-stack">
            <legend>{t('projects.add.role')}</legend>
            {(['storage', 'backup'] as Role[]).map((r) => (
              <label key={r} className="check">
                <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} />
                <span>{t(`wizard.choice.${r}` as MessageKey)}</span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
      {error !== null && <ErrorNotice error={error} />}
    </Modal>
  )
}

function DeleteDialog({ project, onClose, onPreview }: { project: ProjectView; onClose: () => void; onPreview: (p: Pending) => void }) {
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

function ProjectCard({ view, onPreview }: { view: ProjectView; onPreview: (p: Pending) => void }) {
  const { disks } = useAppState()
  const [dialog, setDialog] = useState<'add' | 'delete' | null>(null)
  const diskName = (id: string) => {
    const disk = disks.find((d) => d.id === id)
    return disk ? nameOf(disk) : t('common.unknownDisk')
  }
  const label = (id?: string) => view.assignments.find((a) => a.id === id)?.label ?? ''
  const warnings = view.topology.warnings.filter((w) => w.code === 'no_source' || w.code === 'no_backup')

  return (
    <article className="card project" data-testid="project-card" aria-labelledby={domId('project', view.project.id)}>
      <header className="project__header">
        <h3 id={domId('project', view.project.id)} className="card__title">
          {view.project.name}
        </h3>
        <div className="actions actions--tight">
          <button type="button" className="btn btn--sm" onClick={() => setDialog('add')}>
            {t('projects.add.button')}
          </button>
          <button type="button" className="btn btn--sm btn--danger-outline" onClick={() => setDialog('delete')} disabled={!view.assignments.some((a) => a.role === 'storage')}>
            {t('projects.delete.button')}
          </button>
        </div>
      </header>
      {warnings.map((w) => (
        <p key={`${w.code}-${w.assignmentId ?? ''}`} className="alert alert--warn-inline" data-testid="project-warning">
          {t(`projects.warning.${w.code}` as MessageKey, { folder: label(w.assignmentId) })}
        </p>
      ))}
      {view.assignments.length === 0 ? (
        <p className="muted">{t('projects.noFolders')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('projects.columns.folder')}</th>
              <th scope="col">{t('projects.columns.disk')}</th>
              <th scope="col">{t('projects.columns.role')}</th>
            </tr>
          </thead>
          <tbody>
            {view.assignments.map((a) => (
              <tr key={a.id}>
                <td className="table__primary">{a.label}</td>
                <td>{diskName(a.diskId)}</td>
                <td>
                  <Badge tone={a.role === 'storage' ? 'accent' : 'ok'}>{t(`projects.role.${a.role}`)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog === 'add' && <AddDiskDialog project={view} onClose={() => setDialog(null)} onPreview={onPreview} />}
      {dialog === 'delete' && <DeleteDialog project={view} onClose={() => setDialog(null)} onPreview={onPreview} />}
    </article>
  )
}

export function Projects() {
  const { projects } = useAppState()
  const navigate = useNavigate()
  const [pending, setPending] = useState<Pending | null>(null)

  if (projects.length === 0) {
    return (
      <EmptyState
        title={t('projects.empty.title')}
        body={t('projects.empty.body')}
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
      {projects.map((view) => (
        <ProjectCard key={view.project.id} view={view} onPreview={setPending} />
      ))}
      {pending && <PreviewDialog {...pending} onClose={() => setPending(null)} />}
    </div>
  )
}
