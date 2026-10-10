import { useEffect, useState } from 'react'
import { api, serviceBridge } from '../api/client'
import type { ReconstructedProject } from '../api/types'
import { Disclosure, EmptyState, ErrorNotice } from '../components/ui'
import { t } from '../i18n'
import { formatList } from '../i18n/format'
import { useAppState } from '../state/AppState'

export function Settings() {
  const { connection, refresh } = useAppState()
  const [version, setVersion] = useState<string | null>(null)
  const [found, setFound] = useState<ReconstructedProject[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api<{ version: string }>('GET', '/v1/health').then(
      (health) => setVersion(health.version),
      () => setVersion(null)
    )
  }, [])

  const search = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setFound((await api<{ projects: ReconstructedProject[] }>('POST', '/v1/recovery/scan')).projects)
    } catch (e) {
      setError(e)
    }
    setBusy(false)
  }

  const recover = async (projectId: string): Promise<void> => {
    setError(null)
    try {
      await api('POST', '/v1/recovery/import', { projectId })
      setFound((current) => current?.filter((p) => p.id !== projectId) ?? null)
      await refresh()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <div className="grid-2 settings">
      <section className="card" aria-labelledby="appearance-title">
        <h2 id="appearance-title" className="card__title">
          {t('settings.appearance.title')}
        </h2>
        <p>{t('settings.appearance.body')}</p>
      </section>

      <section className="card" aria-labelledby="connection-title">
        <h2 id="connection-title" className="card__title">
          {t('settings.connection.title')}
        </h2>
        <p>{t(`settings.connection.${connection}`)}</p>
        <p className="muted">{t('settings.connection.independent')}</p>
        <Disclosure label="settings.advanced">
          <dl className="props">
            <div className="props__row">
              <dt>{t('settings.connection.address')}</dt>
              <dd className="mono">{serviceBridge()?.baseUrl ?? t('common.none')}</dd>
            </div>
          </dl>
        </Disclosure>
      </section>

      <section className="card" aria-labelledby="recovery-title">
        <h2 id="recovery-title" className="card__title">
          {t('settings.recovery.title')}
        </h2>
        <p>{t('settings.recovery.body')}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={() => void search()} disabled={busy}>
            {t('settings.recovery.search')}
          </button>
        </div>
        {error !== null && <ErrorNotice error={error} />}
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
      </section>

      <section className="card" aria-labelledby="about-title">
        <h2 id="about-title" className="card__title">
          {t('settings.about.title')}
        </h2>
        <p>{t('settings.about.body')}</p>
        {version && <p className="muted">{t('settings.about.version', { version })}</p>}
      </section>
    </div>
  )
}
