import { useState, type ReactNode } from 'react'
import { domId } from '../lib/dom'
import { api } from '../api/client'
import type { Disk, Job, Plan } from '../api/types'
import { LastRun } from '../components/PolicyRun'
import { RunningJob } from '../components/RunningJob'
import { Badge, Button, Disclosure, EmptyState, ErrorNotice, PreviewDialog, ProgressBar, Semaphore, type PreviewProps } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatBytes, formatNumber, formatPercent } from '../i18n/format'
import { diskName, diskStatus, folderPath, suggestedAction } from '../lib/disks'
import { isActive } from '../lib/jobs'
import { useAction } from '../lib/useAction'
import { useDiskScan } from '../lib/useDiskScan'
import { useNavigate } from '../navigation'
import { useAppState } from '../state/AppState'

const SMART_ATTRIBUTES = ['5', '197', '198', '199']

type Pending = Omit<PreviewProps, 'onClose'>

function Row({ label, children, mono = false }: { label: MessageKey; children: ReactNode; mono?: boolean }) {
  return (
    <div className="props__row">
      <dt>{t(label)}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  )
}

function TechnicalDetails({ disk }: { disk: Disk }) {
  const smart = disk.smart
  return (
    <Disclosure label="disks.technical.title">
      <dl className="props" data-testid="technical-details">
        <Row label="disks.technical.serial" mono>
          {disk.serial ?? t('common.none')}
        </Row>
        <Row label="disks.technical.wwn" mono>
          {disk.wwn ?? t('common.none')}
        </Row>
        <Row label="disks.technical.bus">{disk.bus}</Row>
        <Row label="disks.technical.device" mono>
          {disk.devicePath}
        </Row>
        <Row label="disks.technical.mount" mono>
          {disk.mountPath ?? t('common.none')}
        </Row>
        <Row label="disks.technical.size">{formatBytes(disk.sizeBytes)}</Row>
        <Row label="disks.technical.smart">{t(!smart ? 'disks.technical.smartNone' : smart.passed === false ? 'disks.technical.smartFailed' : 'disks.technical.smartOk')}</Row>
        {smart &&
          SMART_ATTRIBUTES.filter((id) => smart.attributes[id] !== undefined).map((id) => (
            <Row key={id} label={`disks.technical.attribute.${id}` as MessageKey}>
              {formatNumber(smart.attributes[id] ?? 0, 0)}
            </Row>
          ))}
        {smart?.temperatureC != null && <Row label="disks.technical.temperature">{t('disks.technical.celsius', { value: formatNumber(smart.temperatureC, 0) })}</Row>}
        {smart?.powerOnHours != null && <Row label="disks.technical.hours">{formatNumber(smart.powerOnHours, 0)}</Row>}
      </dl>
    </Disclosure>
  )
}

function DiskCard({ disk, onPreview }: { disk: Disk; onPreview: (pending: Pending) => void }) {
  const { refresh, projects, jobs, track } = useAppState()
  const navigate = useNavigate()
  const { pending, error, run } = useAction<'repair' | 'retire'>()
  const [editing, setEditing] = useState(false)
  const repairs = jobs.filter((j) => j.kind === 'repair' && j.diskId === disk.id)
  const repairing = repairs.find(isActive)
  const lastRepair = repairs.find((j) => !isActive(j) && j.finishedAt)
  // A project with a scheduled copy changes its folders in its own form, not by pulling the disk from under it
  const [inUse, setInUse] = useState<string | null>(null)
  const uses = disk.assignments.map((a) => ({ ...a, project: projects.find((p) => p.project.id === a.projectId) }))
  const status = diskStatus(disk)
  const action = suggestedAction(disk)
  const usedPercent = disk.capacity ? (disk.capacity.usedBytes / Math.max(1, disk.capacity.totalBytes)) * 100 : 0

  const repair = () =>
    run('repair', async () => {
      const plan = await api<Plan>('POST', `/v1/disks/${disk.id}/repairs`)
      onPreview({
        title: t('disks.repair.title', { disk: diskName(disk) }),
        summary: plan.preview.summary,
        lines: plan.preview.lines,
        confirmLabel: t('disks.repair.confirm'),
        onConfirm: async () => {
          const confirmed = await api<{ result: { job: Job } }>('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
          track(confirmed.result.job)
        }
      })
    })

  const retire = () => {
    const scheduled = uses.find((u) => u.project && u.project.policies.length > 0)
    if (scheduled?.project) {
      setInUse(scheduled.project.project.id)
      return
    }
    void run('retire', async () => {
      const byProject = new Map<string, string[]>()
      for (const a of disk.assignments) byProject.set(a.projectId, [...(byProject.get(a.projectId) ?? []), a.assignmentId])
      const plans: Plan[] = []
      for (const [projectId, ids] of byProject) {
        const { plan } = await api<{ plan: Plan }>('POST', `/v1/projects/${projectId}/plans`, {
          actions: ids.map((assignmentId) => ({ type: 'remove_assignment', assignmentId }))
        })
        plans.push(plan)
      }
      onPreview({
        title: t('disks.retire.title', { disk: diskName(disk) }),
        summary: t('disks.retire.summary', { disk: diskName(disk) }),
        lines: plans.flatMap((p) => p.preview.lines),
        confirmLabel: t('disks.retire.confirm'),
        danger: true,
        onConfirm: async () => {
          for (const plan of plans) await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
          await refresh()
        }
      })
    })
  }

  return (
    <article className="card disk-card" data-testid="disk-card" data-disk={disk.id} data-health={status} aria-labelledby={domId('disk', disk.id)}>
      <header className="disk-card__header">
        <Semaphore status={status} />
        <h3 id={domId('disk', disk.id)} className="disk-card__name">
          {diskName(disk)}
        </h3>
        <Badge tone={!disk.connected ? 'muted' : disk.state === 'assigned' ? 'accent' : 'warn'}>
          {t(!disk.connected ? 'disks.state.disconnected' : disk.state === 'assigned' ? 'disks.state.assigned' : 'disks.state.unassigned')}
        </Badge>
      </header>

      <p className="disk-card__phrase" data-testid="disk-phrase">
        {disk.connected ? t(`health.phrase.${disk.health}`) : t('disks.disconnectedPhrase')}
      </p>
      {disk.advisories.some((a) => a.code === 'cable') && <p className="alert alert--info">{t('disks.advice.cable')}</p>}

      {disk.capacity && (
        <div className="disk-card__space" data-testid="disk-space">
          <ProgressBar percent={usedPercent} label={t('disks.spaceLabel')} />
          <p className="disk-card__numbers">
            <span>{t('disks.used', { value: formatBytes(disk.capacity.usedBytes), percent: formatPercent(usedPercent) })}</span>
            <span>{t('disks.free', { value: formatBytes(disk.capacity.freeBytes) })}</span>
          </p>
          {disk.capacity.daysUntilFull !== null && <p className="muted">{t('disks.fullIn', { days: formatNumber(disk.capacity.daysUntilFull, 0) })}</p>}
        </div>
      )}

      {uses.length > 0 && (
        <ul className="disk-card__uses" aria-label={t('disks.usedIn')}>
          {uses.map((u) => (
            <li key={u.assignmentId}>
              {t(u.role === 'storage' ? 'disks.use.storage' : 'disks.use.backup', { project: u.project?.project.name ?? '', folder: folderPath(disk, u.folder) })}
            </li>
          ))}
        </ul>
      )}

      {repairing && <RunningJob job={repairing} name={diskName(disk)} />}
      {!repairing && lastRepair && <LastRun job={lastRepair} />}

      <div className="disk-card__action" data-testid="disk-action" data-action={action}>
        {action === 'repair' && !repairing && (
          <Button variant="primary" pending={pending === 'repair'} pendingLabel={t('common.preparing')} onClick={() => void repair()}>
            {t('disks.action.repair')}
          </Button>
        )}
        {action !== 'repair' && action !== 'none' && <p className="disk-card__hint">{t(`disks.suggest.${action}` as MessageKey)}</p>}
        <Button size="sm" aria-expanded={editing} aria-controls={domId('edit', disk.id)} onClick={() => setEditing(!editing)}>
          {t('disks.action.edit')}
        </Button>
      </div>
      {editing && (
        <div id={domId('edit', disk.id)} className="disk-card__edit" data-testid="disk-edit">
          <Button size="sm" onClick={() => navigate('projects', { kind: 'newProject', diskId: disk.id })}>
            {t('disks.action.use')}
          </Button>
          {disk.state === 'assigned' && (
            <Button variant="danger-outline" size="sm" pending={pending === 'retire'} pendingLabel={t('common.preparing')} onClick={retire}>
              {t('disks.action.retire')}
            </Button>
          )}
        </div>
      )}
      {inUse && (
        <div className="alert alert--warn-inline" role="status">
          <p>{t('disks.retire.inUse', { project: projects.find((p) => p.project.id === inUse)?.project.name ?? '' })}</p>
          <Button size="sm" onClick={() => navigate('projects', { kind: 'editProject', projectId: inUse })}>
            {t('disks.retire.editProject')}
          </Button>
        </div>
      )}
      {error !== null && <ErrorNotice error={error} />}

      <TechnicalDetails disk={disk} />
    </article>
  )
}

export function Disks() {
  const { disks } = useAppState()
  const [pending, setPending] = useState<Pending | null>(null)
  const { scanning, done, error, scan } = useDiskScan()

  const scanButton = (
    <Button pending={scanning} pendingLabel={t('jobs.working', { doing: t('jobs.doing.inventory_scan') })} onClick={() => void scan()}>
      {t('disks.scan')}
    </Button>
  )
  const scanNote = done && (
    <p className="muted" role="status" data-testid="scan-done">
      {t('disks.scanDone')}
    </p>
  )

  return (
    <div className="stack">
      {error !== null && <ErrorNotice error={error} />}
      {disks.length === 0 ? (
        <EmptyState
          title={t('disks.empty.title')}
          body={t('disks.empty.body')}
          action={
            <>
              {scanButton}
              {scanNote}
            </>
          }
        />
      ) : (
        <>
          <div className="toolbar">
            {scanNote}
            {scanButton}
          </div>
          <div className="grid-2">
            {disks.map((disk) => (
              <DiskCard key={disk.id} disk={disk} onPreview={setPending} />
            ))}
          </div>
        </>
      )}
      {pending && <PreviewDialog {...pending} onClose={() => setPending(null)} />}
    </div>
  )
}
