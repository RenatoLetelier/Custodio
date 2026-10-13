import { useEffect, useState, type ReactNode } from 'react'
import { api, serviceBridge } from '../api/client'
import type { ReconstructedProject } from '../api/types'
import { Disclosure, EmptyState, ErrorNotice, Semaphore } from '../components/ui'
import { t, type MessageKey } from '../i18n'
import { formatDateTime, formatFolder, formatList } from '../i18n/format'
import { useAppState } from '../state/AppState'

// A settings page: each section answers one question, each row is a name on the left and its value or control on the right
function Section({ id, heading, intro, children }: { id: string; heading: MessageKey; intro?: MessageKey; children: ReactNode }) {
  return (
    <section className="card settings-section" aria-labelledby={id} data-testid={id}>
      <h2 id={id} className="card__title">
        {t(heading)}
      </h2>
      {intro && <p className="muted">{t(intro)}</p>}
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: MessageKey; hint?: MessageKey; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__label">
        <span>{t(label)}</span>
        {hint && <span className="muted">{t(hint)}</span>}
      </div>
      <div className="settings-row__value">{children}</div>
    </div>
  )
}

export function Settings() {
  const { connection, refresh } = useAppState()
  const [health, setHealth] = useState<{ version: string; startedAt: string } | null>(null)
  const [found, setFound] = useState<ReconstructedProject[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const bridge = window.custodio

  useEffect(() => {
    api<{ version: string; startedAt: string }>('GET', '/v1/health').then(setHealth, () => setHealth(null))
  }, [])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e)
    }
    setBusy(false)
  }

  const search = () =>
    run(async () => {
      setFound((await api<{ projects: ReconstructedProject[] }>('POST', '/v1/recovery/scan')).projects)
    })

  const scan = () =>
    run(async () => {
      await api('POST', '/v1/disks/scan')
      setScanned(true)
      await refresh()
    })

  const recover = (projectId: string) =>
    run(async () => {
      await api('POST', '/v1/recovery/import', { projectId })
      setFound((current) => current?.filter((p) => p.id !== projectId) ?? null)
      await refresh()
    })

  return (
    <div className="stack settings">
      {error !== null && <ErrorNotice error={error} />}

      <Section id="settings-service" heading="settings.service.title" intro="settings.service.intro">
        <Row label="settings.service.state">
          <span className="settings-status">
            <Semaphore status={connection === 'online' ? 'green' : 'red'} />
            {t(`settings.connection.${connection}`)}
          </span>
        </Row>
        {health && (
          <>
            <Row label="settings.service.since">{formatDateTime(health.startedAt)}</Row>
            <Row label="settings.service.version">{health.version}</Row>
          </>
        )}
      </Section>

      <Section id="settings-disks" heading="settings.disks.title">
        <Row label="settings.disks.check" hint="settings.disks.checkHint">
          <button type="button" className="btn btn--sm" onClick={() => void scan()} disabled={busy}>
            {t('settings.disks.checkNow')}
          </button>
          {scanned && <span className="muted">{t('settings.disks.checked')}</span>}
        </Row>
      </Section>

      <Section id="settings-app" heading="settings.app.title">
        <Row label="settings.app.theme">{t('settings.appearance.body')}</Row>
        <Row label="settings.app.startup">{t('settings.app.startupValue')}</Row>
        <Row label="settings.app.alerts">{t('settings.app.alertsValue')}</Row>
      </Section>

      <Section id="settings-recovery" heading="settings.recovery.title" intro="settings.recovery.body">
        <div className="actions">
          <button type="button" className="btn" onClick={() => void search()} disabled={busy}>
            {t('settings.recovery.search')}
          </button>
        </div>
        {found !== null &&
          (found.length === 0 ? (
            <EmptyState title={t('settings.recovery.none')} body={t('settings.recovery.noneHint')} />
          ) : (
            <ul className="file-list">
              {found.map((project) => (
                <li key={project.id} className="file-list__item">
                  <div className="file-list__main">
                    <span className="file-list__name">{project.name}</span>
                    <span className="muted">{formatList(project.assignments.map((a) => a.disk.model))}</span>
                  </div>
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => void recover(project.id)}>
                    {t('settings.recovery.recover')}
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </Section>

      <Section id="settings-data" heading="settings.data.title" intro="settings.data.intro">
        <Disclosure label="settings.advanced">
          <div className="settings-rows">
            {bridge?.dataDir && (
              <Row label="settings.data.folder">
                <span className="mono">{formatFolder(bridge.dataDir, '')}</span>
              </Row>
            )}
            {bridge?.dataDir && (
              <Row label="settings.data.logs">
                <span className="mono">{formatFolder(bridge.dataDir, 'logs')}</span>
                {bridge.openLogs && (
                  <button type="button" className="btn btn--sm" onClick={() => void bridge.openLogs?.()}>
                    {t('settings.data.openLogs')}
                  </button>
                )}
              </Row>
            )}
            <Row label="settings.connection.address">
              <span className="mono">{serviceBridge()?.baseUrl ?? t('common.none')}</span>
            </Row>
          </div>
        </Disclosure>
      </Section>
    </div>
  )
}
