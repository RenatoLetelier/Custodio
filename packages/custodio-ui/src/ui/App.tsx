import { useCallback, useMemo, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { ErrorNotice } from './components/ui'
import { t } from './i18n'
import { FirstRunContext, IntentContext, NavigationContext, SECTIONS, type Intent, type SectionId } from './navigation'
import { Activity } from './sections/Activity'
import { Backups } from './sections/Backups'
import { Disks } from './sections/Disks'
import { Overview } from './sections/Overview'
import { Projects } from './sections/Projects'
import { Settings } from './sections/Settings'
import { AppStateProvider, useAppState } from './state/AppState'

const VIEWS: Record<SectionId, () => React.JSX.Element | null> = {
  overview: Overview,
  disks: Disks,
  projects: Projects,
  backups: Backups,
  activity: Activity,
  settings: Settings
}

export function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  )
}

function Shell() {
  const { loaded, error, connection, refresh } = useAppState()
  const [active, setActive] = useState<SectionId>('overview')
  const [postponed, setPostponed] = useState(false)
  const [intent, setIntent] = useState<Intent | null>(null)
  const firstRun = useMemo(() => ({ postponed, setPostponed }), [postponed])
  const go = useCallback((next: SectionId, wanted?: Intent) => {
    setIntent(wanted ?? null)
    setActive(next)
  }, [])
  const intentValue = useMemo(() => ({ intent, clear: () => setIntent(null) }), [intent])
  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]!
  const View = VIEWS[active]

  return (
    <NavigationContext value={go}>
      <IntentContext value={intentValue}>
      <FirstRunContext value={firstRun}>
      <a className="skip-link" href="#panel-content">
        {t('nav.skip')}
      </a>
      <div className="layout" data-testid={loaded ? 'app-ready' : 'app-loading'}>
        <Sidebar active={active} onSelect={(next) => go(next)} />
        <main className="panel" aria-labelledby="panel-title">
          <header className="panel__header">
            <h1 id="panel-title" className="panel__title">
              {t(section.label)}
            </h1>
            <p className="panel__description">{t(section.description)}</p>
          </header>
          {loaded && connection === 'offline' && (
            <div className="alert alert--warn alert--banner" role="status">
              {t('connection.lost')}
            </div>
          )}
          <div id="panel-content" className="panel__content" tabIndex={-1} data-section={active}>
            {loaded ? (
              <View />
            ) : error !== null ? (
              <ErrorNotice error={error} onRetry={() => void refresh()} />
            ) : (
              <p className="muted">{t('connection.connecting')}</p>
            )}
          </div>
        </main>
      </div>
      </FirstRunContext>
      </IntentContext>
    </NavigationContext>
  )
}
