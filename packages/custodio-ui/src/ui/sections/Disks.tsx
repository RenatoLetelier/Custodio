import { useState, type ReactNode } from 'react'
import { domId } from '../lib/dom'
import { api } from '../api/client'
import type { Disk, Plan } from '../api/types'
import { Badge, Disclosure, EmptyState, ErrorNotice, PreviewDialog, ProgressBar, Semaphore, type PreviewProps } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatBytes, formatNumber, formatPercent } from '../i18n/format'
import { diskName, diskStatus, suggestedAction } from '../lib/disks'
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
  const { refresh, projects } = useAppState()
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  const status = diskStatus(disk)
  const action = suggestedAction(disk)
  const usedPercent = disk.capacity ? (disk.capacity.usedBytes / Math.max(1, disk.capacity.totalBytes)) * 100 : 0

  const repair = async (): Promise<void> => {
    setError(null)
    try {
      const plan = await api<Plan>('POST', `/v1/disks/${disk.id}/repairs`)
      onPreview({
        title: t('disks.repair.title', { disk: diskName(disk) }),
        summary: plan.preview.summary,
        lines: plan.preview.lines,
        confirmLabel: t('disks.repair.confirm'),
        onConfirm: async () => {
          await api('POST', `/v1/plans/${plan.id}/confirm`, { confirm: true })
          await refresh()
        }
      })
    } catch (e) {
      setError(e)
    }
  }

  const retire = async (): Promise<void> => {
    setError(null)
    try {
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
    } catch (e) {
      setError(e)
    }
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

      <div className="disk-card__action" data-testid="disk-action" data-action={action}>
        {action === 'repair' && (
          <button type="button" className="btn btn--primary" onClick={() => void repair()}>
            {t('disks.action.repair')}
          </button>
        )}
        {action === 'use' && (
          <button type="button" className="btn btn--primary" onClick={() => navigate(projects.length === 0 ? 'overview' : 'projects')}>
            {t('disks.action.use')}
          </button>
        )}
        {action !== 'repair' && action !== 'use' && <p className="disk-card__hint">{t(`disks.action.${action}` as MessageKey)}</p>}
        {disk.state === 'assigned' && (
          <button type="button" className="btn btn--danger-outline btn--sm" onClick={() => void retire()}>
            {t('disks.action.retire')}
          </button>
        )}
      </div>
      {error !== null && <ErrorNotice error={error} />}

      <TechnicalDetails disk={disk} />
    </article>
  )
}

export function Disks() {
  const { disks, refresh } = useAppState()
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState<unknown>(null)

  const scan = async (): Promise<void> => {
    setError(null)
    try {
      await api('POST', '/v1/disks/scan')
      await new Promise((resolve) => setTimeout(resolve, 400))
      await refresh()
    } catch (e) {
      setError(e)
    }
  }

  const scanButton = (
    <button type="button" className="btn" onClick={() => void scan()}>
      {t('disks.scan')}
    </button>
  )

  return (
    <div className="stack">
      {error !== null && <ErrorNotice error={error} />}
      {disks.length === 0 ? (
        <EmptyState title={t('disks.empty.title')} body={t('disks.empty.body')} action={scanButton} />
      ) : (
        <>
          <div className="toolbar">{scanButton}</div>
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
